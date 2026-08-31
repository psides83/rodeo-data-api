import {
  type Env,
  currentAndPreviousCentralMonths,
  databaseError,
  errorMessage,
  finishMonthlyMoneyRun,
  getSql,
  isRecord,
  json,
  moneyValue,
  monthParam,
  numberParam,
  startMonthlyMoneyRun,
  stringParam,
  valueAt
} from "./shared";

const DEFAULT_MONTHLY_MONEY_EVENTS = ["BB", "SB", "BR", "TD", "SW", "TR", "HD", "HL", "SR", "GB", "LB"];
const MAX_MONTHLY_MONEY_RODEO_LIMIT = 10;
const DEFAULT_MONTHLY_MONEY_RODEO_LIMIT = 5;
const DEFAULT_MONTHLY_MONEY_BACKFILL_RODEO_LIMIT = 5;
const DEFAULT_MONTHLY_MONEY_REQUEST_DELAY_MS = 1500;
const DEFAULT_PRCA_API_BASE = "https://d1kfpvgfupbmyo.cloudfront.net/services/pro_rodeo.ashx";

function monthlyMoneyEvents(env: Env): string[] {
  const configured = env.MONTHLY_MONEY_REFRESH_EVENTS?.split(",")
    .map((event) => event.trim().toUpperCase())
    .filter(Boolean);

  return configured?.length ? Array.from(new Set(configured)) : DEFAULT_MONTHLY_MONEY_EVENTS;
}

function monthlyMoneyRodeoLimit(env: Env): number {
  const parsed = Number(env.MONTHLY_MONEY_RODEO_LIMIT);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_MONTHLY_MONEY_RODEO_LIMIT;
  }

  return Math.min(Math.max(Math.floor(parsed), 1), MAX_MONTHLY_MONEY_RODEO_LIMIT);
}

function monthlyMoneyBackfillRodeoLimit(url: URL, env: Env): number {
  const requested = numberParam(url, "limit");
  const configured = Number(env.MONTHLY_MONEY_BACKFILL_RODEO_LIMIT);
  const value = requested ?? (Number.isFinite(configured) ? configured : DEFAULT_MONTHLY_MONEY_BACKFILL_RODEO_LIMIT);
  return Math.min(Math.max(Math.floor(value), 1), MAX_MONTHLY_MONEY_RODEO_LIMIT);
}

function booleanParam(url: URL, name: string): boolean {
  const raw = stringParam(url, name)?.toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

function monthlyMoneyRequestDelayMs(env: Env): number {
  const parsed = Number(env.MONTHLY_MONEY_REQUEST_DELAY_MS);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_MONTHLY_MONEY_REQUEST_DELAY_MS;
  }

  return Math.min(Math.max(Math.floor(parsed), 0), 30_000);
}

export async function getMonthlyEventMoneyEarners(url: URL, env: Env): Promise<Response> {
  const month = monthParam(url, "month");
  const event = stringParam(url, "event")?.toUpperCase();

  if (!month || !event) {
    return json({ error: "month and event are required" }, 400);
  }

  const sql = getSql(env);

  try {
    const rows = await sql`
      select
        contestant_id,
        name,
        hometown,
        image_url,
        earnings,
        rodeos_count,
        rank,
        updated_at
      from monthly_event_money_earners
      where month = ${month}::date
        and event = ${event}
      order by rank asc
    `;

    const lastUpdated = rows.reduce<string | null>((latest, row) => {
      const updatedAt = String((row as { updated_at: unknown }).updated_at);
      return latest === null || updatedAt > latest ? updatedAt : latest;
    }, null);

    return json({ month: month.slice(0, 7), event, updated_at: lastUpdated, data: rows });
  } catch (error) {
    return databaseError(error);
  }
}

export async function getMonthlyOverallMoneyEarners(url: URL, env: Env): Promise<Response> {
  const month = monthParam(url, "month");

  if (!month) {
    return json({ error: "month is required" }, 400);
  }

  const sql = getSql(env);

  try {
    const rows = await sql`
      select
        contestant_id,
        name,
        hometown,
        image_url,
        earnings,
        events_count,
        rodeos_count,
        rank,
        updated_at
      from monthly_overall_money_earners
      where month = ${month}::date
      order by rank asc
    `;

    const lastUpdated = rows.reduce<string | null>((latest, row) => {
      const updatedAt = String((row as { updated_at: unknown }).updated_at);
      return latest === null || updatedAt > latest ? updatedAt : latest;
    }, null);

    return json({ month: month.slice(0, 7), updated_at: lastUpdated, data: rows });
  } catch (error) {
    return databaseError(error);
  }
}

export async function getMonthlyMoneyBackfillStatus(url: URL, env: Env): Promise<Response> {
  const currentMonth = currentAndPreviousCentralMonths()[0];
  const currentYear = Number(currentMonth.slice(0, 4));
  const year = numberParam(url, "year") ?? currentYear;
  const endDate = year === currentYear ? nextMonthStart(currentMonth) : `${year + 1}-01-01`;
  const options = {
    limit: 1,
    delayMs: 0,
    startDate: `${year}-01-01`,
    endDate
  };
  const sql = getSql(env);

  try {
    const [runRows, processedRows, remainingRodeosCount] = await Promise.all([
      sql`
        select
          id,
          month,
          event,
          status,
          started_at,
          finished_at,
          source_rodeos_count,
          error_message
        from monthly_event_money_runs
        where month >= ${options.startDate}::date
          and month < ${options.endDate}::date
        order by started_at desc
        limit 10
      `,
      sql`
        select
          rodeo_id,
          rodeo_name,
          month,
          status,
          processed_at,
          result_rows_count,
          error_message
        from monthly_money_processed_rodeos
        where month >= ${options.startDate}::date
          and month < ${options.endDate}::date
        order by processed_at desc
        limit 20
      `,
      countCompletedUnprocessedRodeos(env, options)
    ]);

    return json({
      year,
      remaining_rodeos_count: remainingRodeosCount,
      runs: runRows.map((row) => ({
        id: Number(row.id),
        month: dateOnly(row.month).slice(0, 7),
        event: row.event,
        status: row.status,
        started_at: row.started_at,
        finished_at: row.finished_at,
        rodeos_checked_so_far: Number(row.source_rodeos_count ?? 0),
        message: row.error_message
      })),
      recent_rodeos: processedRows.map((row) => ({
        rodeo_id: row.rodeo_id,
        rodeo_name: row.rodeo_name,
        month: dateOnly(row.month).slice(0, 7),
        status: row.status,
        processed_at: row.processed_at,
        result_rows_count: Number(row.result_rows_count ?? 0),
        error_message: row.error_message
      }))
    });
  } catch (error) {
    return databaseError(error);
  }
}

export async function refreshMonthlyMoneyEarners(env: Env): Promise<void> {
  const runMonth = currentAndPreviousCentralMonths()[0];
  const year = Number(runMonth.slice(0, 4));
  const runId = await startMonthlyMoneyRun(env, runMonth, null);

  try {
    const result = await processMonthlyMoneyRodeos(env, {
      runId,
      limit: monthlyMoneyRodeoLimit(env),
      delayMs: monthlyMoneyRequestDelayMs(env),
      startDate: `${year}-01-01`,
      endDate: nextMonthStart(runMonth)
    });

    await finishMonthlyMoneyRun(env, runId, "succeeded", result.processed_rodeos_count, null);
  } catch (error) {
    await finishMonthlyMoneyRun(env, runId, "failed", 0, errorMessage(error));
  }
}

export async function backfillMonthlyMoneyEarners(url: URL, env: Env): Promise<MonthlyMoneyProcessResult> {
  const currentMonth = currentAndPreviousCentralMonths()[0];
  const currentYear = Number(currentMonth.slice(0, 4));
  const year = numberParam(url, "year") ?? currentYear;
  const endDate = year === currentYear ? nextMonthStart(currentMonth) : `${year + 1}-01-01`;
  const rodeoId = stringParam(url, "rodeo_id");
  const runId = await startMonthlyMoneyRun(env, `${year}-01-01`, null);

  try {
    const result = await processMonthlyMoneyRodeos(env, {
      runId,
      limit: monthlyMoneyBackfillRodeoLimit(url, env),
      delayMs: monthlyMoneyRequestDelayMs(env),
      startDate: `${year}-01-01`,
      endDate,
      rodeoId,
      retryEmptyResults: booleanParam(url, "retry_empty"),
      retryAllProcessed: booleanParam(url, "retry_all"),
      retryBadTextResults: booleanParam(url, "retry_bad_text")
    });

    await finishMonthlyMoneyRun(env, runId, "succeeded", result.processed_rodeos_count, null);
    return result;
  } catch (error) {
    await finishMonthlyMoneyRun(env, runId, "failed", 0, errorMessage(error));
    throw error;
  }
}

type MonthlyMoneyProcessOptions = {
  runId?: number;
  limit: number;
  delayMs: number;
  startDate?: string;
  endDate?: string;
  rodeoId?: string | null;
  retryEmptyResults?: boolean;
  retryAllProcessed?: boolean;
  retryBadTextResults?: boolean;
};

type MonthlyMoneyProcessResult = {
  processed_rodeos_count: number;
  failed_rodeos_count: number;
  touched_months: string[];
  remaining_rodeos_count: number;
};

async function processMonthlyMoneyRodeos(
  env: Env,
  options: MonthlyMoneyProcessOptions
): Promise<MonthlyMoneyProcessResult> {
  const events = monthlyMoneyEvents(env);
  const apiBase = prcaApiBase(env);

  let processedCount = 0;
  let failedCount = 0;
  const touchedMonths = new Set<string>();
  const rodeos = await getCompletedUnprocessedRodeos(env, options);

  console.log(
    `[monthly-money] Starting run ${options.runId ?? "manual"} with ${rodeos.length} rodeos, limit ${options.limit}`
  );
  await updateMonthlyMoneyRunProgress(env, options.runId, 0, 0, `Queued ${rodeos.length} rodeos for this batch`);

  for (const [index, rodeo] of rodeos.entries()) {
    const position = `${index + 1}/${rodeos.length}`;
    console.log(`[monthly-money] ${position} fetching ${rodeo.rodeo_name ?? rodeo.rodeo_id} (${rodeo.rodeo_id})`);
    await updateMonthlyMoneyRunProgress(
      env,
      options.runId,
      processedCount,
      failedCount,
      `${position} fetching ${rodeo.rodeo_name ?? rodeo.rodeo_id}`
    );

    try {
      const payload = await fetchRodeoResults(apiBase, rodeo.rodeo_id);
      const results = parseRodeoMoneyResults(payload, rodeo, events);
      await saveRodeoMoneyResults(env, rodeo, results);
      await markMonthlyMoneyRodeoProcessed(env, rodeo, "succeeded", results.length, null);
      processedCount += 1;
      touchedMonths.add(rodeo.month);
      console.log(
        `[monthly-money] ${position} saved ${results.length} result rows for ${rodeo.rodeo_name ?? rodeo.rodeo_id}`
      );
      await updateMonthlyMoneyRunProgress(
        env,
        options.runId,
        processedCount,
        failedCount,
        `${position} saved ${results.length} result rows for ${rodeo.rodeo_name ?? rodeo.rodeo_id}`
      );
    } catch (error) {
      failedCount += 1;
      await markMonthlyMoneyRodeoProcessed(env, rodeo, "failed", 0, errorMessage(error));
      console.error(`[monthly-money] ${position} failed ${rodeo.rodeo_name ?? rodeo.rodeo_id}: ${errorMessage(error)}`);
      await updateMonthlyMoneyRunProgress(
        env,
        options.runId,
        processedCount,
        failedCount,
        `${position} failed ${rodeo.rodeo_name ?? rodeo.rodeo_id}: ${errorMessage(error)}`
      );
    }

    if (index < rodeos.length - 1 && options.delayMs > 0) {
      console.log(`[monthly-money] Waiting ${options.delayMs}ms before the next rodeo`);
      await sleep(options.delayMs);
    }
  }

  for (const month of touchedMonths) {
    console.log(`[monthly-money] Rebuilding monthly money cache for ${month.slice(0, 7)}`);
    await updateMonthlyMoneyRunProgress(
      env,
      options.runId,
      processedCount,
      failedCount,
      `Rebuilding monthly money cache for ${month.slice(0, 7)}`
    );
    await rebuildMonthlyMoneyCaches(env, month);
  }

  console.log(
    `[monthly-money] Finished run ${options.runId ?? "manual"}: ${processedCount} succeeded, ${failedCount} failed`
  );

  return {
    processed_rodeos_count: processedCount,
    failed_rodeos_count: failedCount,
    touched_months: Array.from(touchedMonths).sort().map((month) => month.slice(0, 7)),
    remaining_rodeos_count: await countCompletedUnprocessedRodeos(env, options)
  };
}

async function updateMonthlyMoneyRunProgress(
  env: Env,
  runId: number | undefined,
  processedCount: number,
  failedCount: number,
  message: string
): Promise<void> {
  if (!runId) return;

  const sql = getSql(env);
  await sql`
    update monthly_event_money_runs
    set
      source_rodeos_count = ${processedCount + failedCount},
      error_message = ${message}
    where id = ${runId}
      and status = 'running'
  `;
}

type MonthlyMoneyRodeo = {
  rodeo_id: string;
  rodeo_name: string | null;
  month: string;
};

type MonthlyMoneyResult = {
  event: string;
  contestant_id: string;
  name: string;
  hometown: string;
  image_url: string | null;
  earnings: number;
};

async function getCompletedUnprocessedRodeos(
  env: Env,
  options: MonthlyMoneyProcessOptions
): Promise<MonthlyMoneyRodeo[]> {
  const sql = getSql(env);
  const rows = await sql`
    with rodeos as (
      select to_jsonb(r) as data
      from prca_rodeos r
    ),
    normalized as (
      select
        data,
        coalesce(data->>'rodeo_id', data->>'RodeoId', data->>'id', data->>'Id') as rodeo_id,
        coalesce(data->>'name', data->>'rodeo_name', data->>'RodeoName') as rodeo_name,
        lower(coalesce(
          data->>'status',
          data->>'Status',
          data->>'result_status',
          data->>'ResultStatus',
          data->>'progress_status',
          data->>'ProgressStatus',
          ''
        )) as status,
        coalesce(
          data->>'end_date',
          data->>'rodeo_end_date',
          data->>'RodeoEndDate',
          data->>'start_date',
          data->>'rodeo_start_date',
          data->>'RodeoStartDate',
          data->>'date',
          data->>'Date'
        ) as raw_date
      from rodeos
    ),
    candidates as (
      select
        rodeo_id,
        rodeo_name,
        case
          when raw_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' then date_trunc('month', left(raw_date, 10)::date)::date
          else null
        end as month
      from normalized
      where rodeo_id is not null
        and status not like '%in progress%'
        and lower(data::text) not like '%in progress%'
    )
    select
      c.rodeo_id,
      c.rodeo_name,
      c.month
    from candidates c
    left join monthly_money_processed_rodeos p
      on p.rodeo_id = c.rodeo_id
    where c.month is not null
      and (
        ${options.retryAllProcessed ?? false}
        or p.rodeo_id is null
        or (${options.retryEmptyResults ?? false} and p.status = 'succeeded' and p.result_rows_count = 0)
        or (
          ${options.retryBadTextResults ?? false}
          and exists (
            select 1
            from monthly_money_rodeo_results existing
            where existing.rodeo_id = c.rodeo_id
              and existing.contestant_id like '%,%'
          )
        )
      )
      and (${options.rodeoId ?? null}::text is null or c.rodeo_id = ${options.rodeoId ?? null})
      and (${options.startDate ?? null}::date is null or c.month >= date_trunc('month', ${options.startDate ?? null}::date)::date)
      and (${options.endDate ?? null}::date is null or c.month < date_trunc('month', ${options.endDate ?? null}::date)::date)
    order by c.month asc, c.rodeo_name asc nulls last, c.rodeo_id asc
    limit ${options.limit}
  `;

  return rows.map((row) => ({
    rodeo_id: String(row.rodeo_id),
    rodeo_name: row.rodeo_name === null || row.rodeo_name === undefined ? null : String(row.rodeo_name),
    month: dateOnly(row.month)
  }));
}

async function countCompletedUnprocessedRodeos(env: Env, options: MonthlyMoneyProcessOptions): Promise<number> {
  const sql = getSql(env);
  const rows = await sql`
    with rodeos as (
      select to_jsonb(r) as data
      from prca_rodeos r
    ),
    normalized as (
      select
        data,
        coalesce(data->>'rodeo_id', data->>'RodeoId', data->>'id', data->>'Id') as rodeo_id,
        lower(coalesce(
          data->>'status',
          data->>'Status',
          data->>'result_status',
          data->>'ResultStatus',
          data->>'progress_status',
          data->>'ProgressStatus',
          ''
        )) as status,
        coalesce(
          data->>'end_date',
          data->>'rodeo_end_date',
          data->>'RodeoEndDate',
          data->>'start_date',
          data->>'rodeo_start_date',
          data->>'RodeoStartDate',
          data->>'date',
          data->>'Date'
        ) as raw_date
      from rodeos
    ),
    candidates as (
      select
        rodeo_id,
        case
          when raw_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' then date_trunc('month', left(raw_date, 10)::date)::date
          else null
        end as month
      from normalized
      where rodeo_id is not null
        and status not like '%in progress%'
        and lower(data::text) not like '%in progress%'
    )
    select count(*)::integer as count
    from candidates c
    left join monthly_money_processed_rodeos p
      on p.rodeo_id = c.rodeo_id
    where c.month is not null
      and (
        ${options.retryAllProcessed ?? false}
        or p.rodeo_id is null
        or (${options.retryEmptyResults ?? false} and p.status = 'succeeded' and p.result_rows_count = 0)
        or (
          ${options.retryBadTextResults ?? false}
          and exists (
            select 1
            from monthly_money_rodeo_results existing
            where existing.rodeo_id = c.rodeo_id
              and existing.contestant_id like '%,%'
          )
        )
      )
      and (${options.rodeoId ?? null}::text is null or c.rodeo_id = ${options.rodeoId ?? null})
      and (${options.startDate ?? null}::date is null or c.month >= date_trunc('month', ${options.startDate ?? null}::date)::date)
      and (${options.endDate ?? null}::date is null or c.month < date_trunc('month', ${options.endDate ?? null}::date)::date)
  `;

  return Number(rows[0]?.count ?? 0);
}

function prcaApiBase(env: Env): string {
  return (env.PRCA_API_BASE ?? DEFAULT_PRCA_API_BASE).replace(/\/$/, "");
}

async function fetchRodeoResults(apiBase: string, rodeoId: string): Promise<unknown> {
  const url = `${apiBase}/rodeo?id=${encodeURIComponent(rodeoId)}`;
  const headers = new Headers({ accept: "application/json" });

  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`Result request failed for rodeo ${rodeoId}: ${response.status}`);
  }

  return response.json();
}

function parseRodeoMoneyResults(payload: unknown, rodeo: MonthlyMoneyRodeo, allowedEvents: string[]): MonthlyMoneyResult[] {
  const contestantLookup = contestantLookupFromPayload(payload);
  return enrichMonthlyMoneyResults(rowsToMonthlyMoneyResults(resultRows(payload, rodeo.rodeo_id), allowedEvents), contestantLookup);
}

function rowsToMonthlyMoneyResults(rows: Record<string, unknown>[], allowedEvents: string[]): MonthlyMoneyResult[] {
  const allowed = new Set(allowedEvents);
  const byContestantEvent = new Map<string, MonthlyMoneyResult>();

  for (const row of rows) {
    const event = valueAt(row, ["event", "Event", "event_abbrev", "EventAbbrev", "EventType", "eventType"])?.toUpperCase();
    const name = valueAt(row, ["name", "contestant_name", "ContestantName", "athlete", "Athlete"]);
    const earnings = moneyValue(valueAt(row, ["payoff", "Payoff", "earnings", "Earnings", "money", "Money"]));

    if (!event || !allowed.has(event) || !name || earnings <= 0) {
      continue;
    }

    const contestantId =
      valueAt(row, ["contestant_id", "ContestantId", "athlete_id", "AthleteId"]) ?? name.toLowerCase();
    const key = `${event}:${contestantId}`;
    const existing = byContestantEvent.get(key);

    if (existing) {
      existing.earnings += earnings;
      continue;
    }

    byContestantEvent.set(key, {
      event,
      contestant_id: contestantId,
      name,
      hometown: valueAt(row, ["hometown", "Hometown"]) ?? "",
      image_url: valueAt(row, ["image_url", "ImageUrl", "photo_url", "PhotoUrl"]),
      earnings
    });
  }

  return Array.from(byContestantEvent.values()).map((result) => ({
    ...result,
    earnings: Number(result.earnings.toFixed(2))
  }));
}

function enrichMonthlyMoneyResults(
  results: MonthlyMoneyResult[],
  contestantLookup: Map<string, ContestantProfile>
): MonthlyMoneyResult[] {
  return results.map((result) => {
    const contestant = contestantLookup.get(normalizeContestantName(result.name));
    if (!contestant) return result;

    return {
      ...result,
      contestant_id: contestant.contestant_id ?? result.contestant_id,
      name: contestant.name ?? result.name,
      hometown: contestant.hometown ?? result.hometown,
      image_url: contestant.image_url ?? result.image_url
    };
  });
}

function resultRows(payload: unknown, rodeoId?: string): Record<string, unknown>[] {
  if (Array.isArray(payload)) {
    return payload.flatMap((item) => resultRows(item, rodeoId));
  }

  if (!isRecord(payload)) {
    return [];
  }

  for (const key of ["data", "results", "Results", "winners", "Winners", "items"]) {
    const value = payload[key];
    if (Array.isArray(value)) {
      const rows = value.flatMap((item) => resultRows(item, rodeoId));
      if (rows.length > 0) return rows;
    }

    if (isRecord(value)) {
      const rows = resultRows(value, rodeoId);
      if (rows.length > 0) return rows;
    }
  }

  const nestedRows = rodeoDetailResultRows(payload, rodeoId);
  if (nestedRows.length > 0) {
    return nestedRows;
  }

  return [];
}

type ContestantProfile = {
  contestant_id: string | null;
  name: string | null;
  hometown: string | null;
  image_url: string | null;
};

function contestantLookupFromPayload(payload: unknown): Map<string, ContestantProfile> {
  const lookup = new Map<string, ContestantProfile>();

  for (const contestant of contestantProfilesFromPayload(payload)) {
    if (!contestant.name) continue;
    lookup.set(normalizeContestantName(contestant.name), contestant);
  }

  return lookup;
}

function contestantProfilesFromPayload(payload: unknown): ContestantProfile[] {
  if (Array.isArray(payload)) {
    return payload.flatMap((item) => contestantProfilesFromPayload(item));
  }

  if (!isRecord(payload)) {
    return [];
  }

  const contestants = payload.Contestant;
  if (isRecord(contestants)) {
    return [contestantProfile(contestants)];
  }

  if (Array.isArray(contestants)) {
    return contestants.filter(isRecord).map(contestantProfile);
  }

  return Object.values(payload).flatMap((value) => contestantProfilesFromPayload(value));
}

function contestantProfile(contestant: Record<string, unknown>): ContestantProfile {
  return {
    contestant_id: valueAt(contestant, ["ContestantId", "contestant_id", "id"]),
    name: contestantName(contestant),
    hometown: valueAt(contestant, ["Hometown", "hometown"]),
    image_url: valueAt(contestant, ["image_315_url", "ImageUrl", "PhotoUrl", "photo_url"])
  };
}

function normalizeContestantName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function rodeoDetailResultRows(rodeo: Record<string, unknown>, rodeoId?: string): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];

  if (isRecord(rodeo.Events)) {
    for (const [eventType, rounds] of Object.entries(rodeo.Events)) {
      if (!isRecord(rounds)) continue;

      for (const [roundKey, roundRows] of Object.entries(rounds)) {
        if (!Array.isArray(roundRows)) continue;

        for (const row of roundRows) {
          if (!isRecord(row)) continue;
          rows.push({
            ...row,
            EventType: valueAt(row, ["EventType", "eventType", "event"]) ?? eventType,
            RoundKey: roundKey
          });
        }
      }
    }
  }

  if (Array.isArray(rodeo.Winners)) {
    for (const winner of rodeo.Winners) {
      if (!isRecord(winner)) continue;
      const winnerRodeoId = valueAt(winner, ["RodeoId", "rodeo_id"]);
      if (rodeoId && winnerRodeoId && winnerRodeoId !== rodeoId) continue;
      rows.push(winner);
    }
  }

  return rows.flatMap((row) => {
    const contestants = row.Contestant;
    if (isRecord(contestants)) {
      return [
        {
          ...row,
          contestant_id: valueAt(contestants, ["ContestantId", "contestant_id", "id"]),
          name: contestantName(contestants),
          hometown: valueAt(contestants, ["Hometown", "hometown"]) ?? "",
          image_url: valueAt(contestants, ["image_315_url", "ImageUrl", "PhotoUrl", "photo_url"])
        }
      ];
    }

    if (!Array.isArray(contestants) || contestants.length === 0) {
      return [row];
    }

    return contestants.filter(isRecord).map((contestant) => ({
      ...row,
      contestant_id: valueAt(contestant, ["ContestantId", "contestant_id", "id"]),
      name: contestantName(contestant),
      hometown: valueAt(contestant, ["Hometown", "hometown"]) ?? "",
      image_url: valueAt(contestant, ["image_315_url", "ImageUrl", "PhotoUrl", "photo_url"])
    }));
  });
}

function contestantName(contestant: Record<string, unknown>): string | null {
  const existing = valueAt(contestant, ["Name", "name", "ContestantName", "contestant_name"]);
  if (existing) return existing;

  const first = valueAt(contestant, ["FirstName", "first_name"]);
  const last = valueAt(contestant, ["LastName", "last_name"]);
  const combined = [first, last].filter(Boolean).join(" ").trim();
  return combined || null;
}

function nextMonthStart(month: string): string {
  const year = Number(month.slice(0, 4));
  const monthNumber = Number(month.slice(5, 7));
  if (monthNumber === 12) {
    return `${year + 1}-01-01`;
  }

  return `${year}-${String(monthNumber + 1).padStart(2, "0")}-01`;
}

function dateOnly(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }

  const raw = String(value);
  const isoMatch = raw.match(/[0-9]{4}-[0-9]{2}-[0-9]{2}/);
  if (isoMatch) {
    return isoMatch[0];
  }

  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toISOString().slice(0, 10);
  }

  throw new Error(`Invalid date value: ${raw}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function saveRodeoMoneyResults(
  env: Env,
  rodeo: MonthlyMoneyRodeo,
  results: MonthlyMoneyResult[]
): Promise<void> {
  const sql = getSql(env);
  const payload = JSON.stringify(results);

  await sql`
    with deleted as (
      delete from monthly_money_rodeo_results
      where rodeo_id = ${rodeo.rodeo_id}
    ),
    input as (
      select *
      from jsonb_to_recordset(${payload}::jsonb) as result(
        event text,
        contestant_id text,
        name text,
        hometown text,
        image_url text,
        earnings numeric
      )
    )
    insert into monthly_money_rodeo_results (
      rodeo_id,
      month,
      event,
      contestant_id,
      name,
      hometown,
      image_url,
      earnings,
      processed_at
    )
    select
      ${rodeo.rodeo_id},
      ${rodeo.month}::date,
      event,
      contestant_id,
      name,
      hometown,
      image_url,
      earnings,
      now()
    from input
    on conflict (rodeo_id, event, contestant_id) do update
    set
      month = excluded.month,
      name = excluded.name,
      hometown = excluded.hometown,
      image_url = excluded.image_url,
      earnings = excluded.earnings,
      processed_at = excluded.processed_at
  `;
}

async function markMonthlyMoneyRodeoProcessed(
  env: Env,
  rodeo: MonthlyMoneyRodeo,
  status: "succeeded" | "failed",
  resultRowsCount: number,
  errorMessageValue: string | null
): Promise<void> {
  const sql = getSql(env);
  await sql`
    insert into monthly_money_processed_rodeos (
      rodeo_id,
      rodeo_name,
      month,
      status,
      processed_at,
      result_rows_count,
      error_message
    )
    values (
      ${rodeo.rodeo_id},
      ${rodeo.rodeo_name},
      ${rodeo.month}::date,
      ${status},
      now(),
      ${resultRowsCount},
      ${errorMessageValue}
    )
    on conflict (rodeo_id) do update
    set
      rodeo_name = excluded.rodeo_name,
      month = excluded.month,
      status = excluded.status,
      processed_at = excluded.processed_at,
      result_rows_count = excluded.result_rows_count,
      error_message = excluded.error_message
  `;
}

async function rebuildMonthlyMoneyCaches(env: Env, month: string): Promise<void> {
  const sql = getSql(env);

  await sql`
    delete from monthly_event_money_earners
    where month = ${month}::date
  `;

  await sql`
    insert into monthly_event_money_earners (
      month,
      event,
      contestant_id,
      name,
      hometown,
      image_url,
      earnings,
      rodeos_count,
      rank,
      updated_at
    )
    with aggregated as (
      select
        month,
        event,
        contestant_id,
        max(name) as name,
        max(hometown) as hometown,
        max(image_url) as image_url,
        sum(earnings)::numeric(12, 2) as earnings,
        count(distinct rodeo_id)::integer as rodeos_count
      from monthly_money_rodeo_results
      where month = ${month}::date
      group by month, event, contestant_id
    ),
    ranked as (
      select
        *,
        row_number() over (partition by event order by earnings desc, name asc) as rank
      from aggregated
    )
    select
      month,
      event,
      contestant_id,
      name,
      hometown,
      image_url,
      earnings,
      rodeos_count,
      rank,
      now()
    from ranked
    where rank <= 20
  `;

  await sql`
    delete from monthly_overall_money_earners
    where month = ${month}::date
  `;

  await sql`
    insert into monthly_overall_money_earners (
      month,
      contestant_id,
      name,
      hometown,
      image_url,
      earnings,
      events_count,
      rodeos_count,
      rank,
      updated_at
    )
    with aggregated as (
      select
        month,
        contestant_id,
        max(name) as name,
        max(hometown) as hometown,
        max(image_url) as image_url,
        sum(earnings)::numeric(12, 2) as earnings,
        count(distinct event)::integer as events_count,
        count(distinct rodeo_id)::integer as rodeos_count
      from monthly_money_rodeo_results
      where month = ${month}::date
      group by month, contestant_id
    ),
    ranked as (
      select
        *,
        row_number() over (order by earnings desc, name asc) as rank
      from aggregated
    )
    select
      month,
      contestant_id,
      name,
      hometown,
      image_url,
      earnings,
      events_count,
      rodeos_count,
      rank,
      now()
    from ranked
    where rank <= 20
  `;
}
