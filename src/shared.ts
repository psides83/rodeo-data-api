import { neon } from "@neondatabase/serverless";

export type Env = {
  DATABASE_URL: string;
  ADMIN_API_KEY?: string;
  CACHE_TTL_SECONDS?: string;
  PRCA_API_BASE?: string;
  PRCA_STANDINGS_CACHE_TTL_SECONDS?: string;
  WPRA_STANDINGS_CACHE_TTL_SECONDS?: string;
  RODEOS_CACHE_TTL_SECONDS?: string;
  PAST_CHAMPIONS_CACHE_TTL_SECONDS?: string;
  MONTHLY_MONEY_CACHE_TTL_SECONDS?: string;
  MONTHLY_MONEY_REFRESH_EVENTS?: string;
  MONTHLY_MONEY_RODEO_LIMIT?: string;
  MONTHLY_MONEY_BACKFILL_RODEO_LIMIT?: string;
  MONTHLY_MONEY_REQUEST_DELAY_MS?: string;
  SCHEMA_CACHE_TTL_SECONDS?: string;
  CACHE_STALE_WHILE_REVALIDATE_SECONDS?: string;
  CACHE_VERSION?: string;
};

export type StandingType =
  | "world"
  | "tour"
  | "circuit"
  | "rookie"
  | "permit"
  | "xtremebulls"
  | "xtremebroncs"
  | "legacysteerroping";

export const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, authorization"
};

export function getSql(env: Env) {
  if (!env.DATABASE_URL) {
    throw new Error("DATABASE_URL secret is missing");
  }

  return neon(env.DATABASE_URL);
}

export function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: jsonHeaders
  });
}

export function databaseError(error: unknown): Response {
  console.error(error);
  const message = error instanceof Error ? error.message : String(error);

  return json(
    {
      ok: false,
      error: "Database request failed",
      detail: message
    },
    500
  );
}

export async function cached(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  fetcher: () => Promise<Response>,
  ttlEnvName: keyof Env = "CACHE_TTL_SECONDS",
  defaultTtl = 300
): Promise<Response> {
  const ttl = cacheTtl(env, ttlEnvName, defaultTtl);
  if (!Number.isFinite(ttl) || ttl <= 0) {
    return clientResponse(await fetcher(), "BYPASS", env);
  }

  const cache = await caches.open("rodeo-data-api");
  const cacheKey = canonicalCacheRequest(request, env);
  const hit = await cache.match(cacheKey);
  if (hit) return clientResponse(hit, "HIT", env);

  const response = await fetcher();
  if (response.ok) {
    const cachedResponse = response.clone();
    cachedResponse.headers.set("cache-control", workerCacheControl(env, ttl));
    ctx.waitUntil(cache.put(cacheKey, cachedResponse));
    return clientResponse(response, "MISS", env);
  }

  return clientResponse(response, "BYPASS", env);
}

function cacheTtl(env: Env, ttlEnvName: keyof Env, defaultTtl: number): number {
  const endpointTtl = Number(env[ttlEnvName]);
  if (Number.isFinite(endpointTtl)) return endpointTtl;

  if (ttlEnvName === "CACHE_TTL_SECONDS") {
    const globalTtl = Number(env.CACHE_TTL_SECONDS);
    return Number.isFinite(globalTtl) ? globalTtl : defaultTtl;
  }

  return defaultTtl;
}

function workerCacheControl(env: Env, ttl: number): string {
  const staleWhileRevalidate = Number(env.CACHE_STALE_WHILE_REVALIDATE_SECONDS ?? ttl * 2);
  const directives = [`public`, `max-age=${ttl}`, `s-maxage=${ttl}`];

  if (Number.isFinite(staleWhileRevalidate) && staleWhileRevalidate > 0) {
    directives.push(`stale-while-revalidate=${staleWhileRevalidate}`);
  }

  return directives.join(", ");
}

export function clientResponse(response: Response, cacheStatus: "HIT" | "MISS" | "BYPASS", env: Env): Response {
  const nextResponse = new Response(response.body, response);
  nextResponse.headers.set("cache-control", "no-store");
  nextResponse.headers.set("x-rodeo-cache", cacheStatus);
  nextResponse.headers.set("x-rodeo-cache-version", env.CACHE_VERSION ?? "1");
  return nextResponse;
}

function canonicalCacheRequest(request: Request, env: Env): Request {
  const url = new URL(request.url);
  url.searchParams.set("__cache_version", env.CACHE_VERSION ?? "1");
  const sortedParams = Array.from(url.searchParams.entries()).sort(([leftName, leftValue], [rightName, rightValue]) => {
    const nameComparison = leftName.localeCompare(rightName);
    return nameComparison === 0 ? leftValue.localeCompare(rightValue) : nameComparison;
  });

  url.search = "";
  for (const [name, value] of sortedParams) {
    url.searchParams.append(name, value);
  }

  return new Request(url.toString(), { method: "GET" });
}

type CentralRefreshSchedule = {
  month?: number;
  day?: number;
  weekday?: number;
  hour: number;
  minute: number;
};

export function secondsUntilNextCentralRefresh(schedule: CentralRefreshSchedule, now = new Date()): number {
  const centralNow = centralDateParts(now);
  const currentSeconds = centralNow.hour * 3600 + centralNow.minute * 60 + centralNow.second;
  const targetSeconds = schedule.hour * 3600 + schedule.minute * 60;

  if (schedule.month !== undefined && schedule.day !== undefined) {
    let target = centralUtcDate(centralNow.year, schedule.month, schedule.day, schedule.hour, schedule.minute, 0);

    if (target.getTime() <= now.getTime()) {
      target = centralUtcDate(centralNow.year + 1, schedule.month, schedule.day, schedule.hour, schedule.minute, 0);
    }

    return Math.max(1, Math.floor((target.getTime() - now.getTime()) / 1000));
  }

  if (schedule.weekday === undefined) {
    const secondsToday = targetSeconds - currentSeconds;
    return secondsToday > 0 ? secondsToday : secondsToday + 86400;
  }

  const dayDelta = (schedule.weekday - centralNow.weekday + 7) % 7;
  const secondsThisWeek = dayDelta * 86400 + targetSeconds - currentSeconds;
  return secondsThisWeek > 0 ? secondsThisWeek : secondsThisWeek + 7 * 86400;
}

function centralDateParts(date: Date) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    weekday: "short",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hourCycle: "h23"
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  const weekdays: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6
  };

  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    weekday: weekdays[parts.weekday] ?? 0,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second)
  };
}

function centralUtcDate(year: number, month: number, day: number, hour: number, minute: number, second: number): Date {
  const approximateUtc = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  const centralParts = centralDateParts(approximateUtc);
  const centralAsUtc = Date.UTC(
    centralParts.year,
    centralParts.month - 1,
    centralParts.day,
    centralParts.hour,
    centralParts.minute,
    centralParts.second
  );
  const intendedAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);

  return new Date(approximateUtc.getTime() + intendedAsUtc - centralAsUtc);
}

export function stringParam(url: URL, name: string): string | null {
  const raw = url.searchParams.get(name);
  const trimmed = raw?.trim();
  return trimmed ? trimmed : null;
}

export function numberParam(url: URL, name: string): number | null {
  const raw = stringParam(url, name);
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isInteger(parsed) ? parsed : null;
}

export function decimalParam(url: URL, name: string): number | null {
  const raw = stringParam(url, name);
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

export function boundedNumberParam(
  url: URL,
  name: string,
  fallback: number,
  min: number,
  max: number
): number {
  const value = numberParam(url, name) ?? fallback;
  return Math.min(Math.max(value, min), max);
}

export function boundedDecimalParam(
  url: URL,
  name: string,
  fallback: number,
  min: number,
  max: number
): number {
  const value = decimalParam(url, name) ?? fallback;
  return Math.min(Math.max(value, min), max);
}

export function monthParam(url: URL, name: string): string | null {
  const raw = stringParam(url, name);
  if (!raw) return null;

  if (/^[0-9]{4}-[0-9]{2}$/.test(raw)) {
    return `${raw}-01`;
  }

  if (/^[0-9]{4}-[0-9]{2}-01$/.test(raw)) {
    return raw;
  }

  return null;
}

export function currentAndPreviousCentralMonths(now = new Date()): string[] {
  const centralNow = centralDateParts(now);
  const current = monthStart(centralNow.year, centralNow.month);
  const previousMonth = centralNow.month === 1 ? 12 : centralNow.month - 1;
  const previousYear = centralNow.month === 1 ? centralNow.year - 1 : centralNow.year;

  return [current, monthStart(previousYear, previousMonth)];
}

function monthStart(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, "0")}-01`;
}

export async function startMonthlyMoneyRun(env: Env, month: string, event: string | null): Promise<number> {
  const sql = getSql(env);
  const rows = await sql`
    insert into monthly_event_money_runs (month, event, status, started_at)
    values (${month}::date, ${event}, 'running', now())
    returning id
  `;

  return Number(rows[0]?.id);
}

export async function finishMonthlyMoneyRun(
  env: Env,
  id: number,
  status: "succeeded" | "failed",
  sourceRodeosCount: number,
  errorMessageValue: string | null
): Promise<void> {
  const sql = getSql(env);
  await sql`
    update monthly_event_money_runs
    set
      status = ${status},
      finished_at = now(),
      source_rodeos_count = ${sourceRodeosCount},
      error_message = ${errorMessageValue}
    where id = ${id}
  `;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function valueAt(row: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }

  return null;
}

export function moneyValue(raw: string | null): number {
  if (!raw) return 0;
  const cleaned = raw.replace(/[^0-9.-]/g, "");
  if (!cleaned || !/^-?[0-9]+(\.[0-9]+)?$/.test(cleaned)) {
    return 0;
  }

  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : 0;
}

export type SchemaColumnRow = {
  table_schema: string;
  table_name: string;
  column_name: string;
  ordinal_position: number;
  data_type: string;
  udt_name: string;
  is_nullable: boolean;
  column_default: string | null;
  estimated_rows: number | string;
};

export function groupSchemaRows(rows: SchemaColumnRow[]) {
  const tables = new Map<
    string,
    {
      schema: string;
      name: string;
      estimated_rows: number;
      columns: Array<{
        name: string;
        position: number;
        data_type: string;
        udt_name: string;
        is_nullable: boolean;
        default: string | null;
      }>;
    }
  >();

  for (const row of rows) {
    const key = `${row.table_schema}.${row.table_name}`;
    const table =
      tables.get(key) ??
      {
        schema: row.table_schema,
        name: row.table_name,
        estimated_rows: Number(row.estimated_rows),
        columns: []
      };

    table.columns.push({
      name: row.column_name,
      position: row.ordinal_position,
      data_type: row.data_type,
      udt_name: row.udt_name,
      is_nullable: row.is_nullable,
      default: row.column_default
    });

    tables.set(key, table);
  }

  return Array.from(tables.values());
}

export function normalizeStandingType(value: string): StandingType | null {
  const cleaned = value.trim().toLowerCase().replace(/\s+/g, "");
  if (cleaned.includes("world")) return "world";
  if (cleaned.includes("tour")) return "tour";
  if (cleaned.includes("circuit")) return "circuit";
  if (cleaned.includes("rookie")) return "rookie";
  if (cleaned.includes("permit")) return "permit";
  if (cleaned.includes("xtremebull") || cleaned.includes("xbull")) return "xtremebulls";
  if (cleaned.includes("xtremebronc") || cleaned.includes("xbronc")) return "xtremebroncs";
  if (cleaned.includes("legacy")) return "legacysteerroping";

  const allowed = new Set<StandingType>([
    "world",
    "tour",
    "circuit",
    "rookie",
    "permit",
    "xtremebulls",
    "xtremebroncs",
    "legacysteerroping"
  ]);

  return allowed.has(cleaned as StandingType) ? (cleaned as StandingType) : null;
}
