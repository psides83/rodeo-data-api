import { neon } from "@neondatabase/serverless";

type Env = {
  DATABASE_URL: string;
  CACHE_TTL_SECONDS?: string;
  PRCA_STANDINGS_CACHE_TTL_SECONDS?: string;
  WPRA_STANDINGS_CACHE_TTL_SECONDS?: string;
  RODEOS_CACHE_TTL_SECONDS?: string;
  PAST_CHAMPIONS_CACHE_TTL_SECONDS?: string;
  SCHEMA_CACHE_TTL_SECONDS?: string;
  CACHE_STALE_WHILE_REVALIDATE_SECONDS?: string;
  CACHE_VERSION?: string;
};

type StandingType =
  | "world"
  | "tour"
  | "circuit"
  | "rookie"
  | "permit"
  | "xtremebulls"
  | "xtremebroncs"
  | "legacysteerroping";

const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "content-type, authorization"
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: jsonHeaders });
    }

    const url = new URL(request.url);

    try {
      if (url.pathname === "/" || url.pathname === "/health") {
        return json({ ok: true });
      }

      if (request.method !== "GET") {
        return json({ error: "Method not allowed" }, 405);
      }

      if (url.pathname === "/v1/db-check") {
        return checkDatabase(env);
      }

      if (url.pathname === "/v1/schema") {
        return cached(request, env, ctx, () => getDatabaseSchema(env), "SCHEMA_CACHE_TTL_SECONDS", 3600);
      }

      if (url.pathname === "/v1/standings" || url.pathname === "/v1/prca/standings") {
        return cached(
          request,
          env,
          ctx,
          () => getPrcaStandings(url, env),
          "PRCA_STANDINGS_CACHE_TTL_SECONDS",
          secondsUntilNextCentralRefresh({ hour: 7, minute: 30 })
        );
      }

      if (url.pathname === "/v1/prca/rodeos" || url.pathname === "/v1/rodeos") {
        return cached(request, env, ctx, () => getPrcaRodeos(url, env), "RODEOS_CACHE_TTL_SECONDS", 1800);
      }

      if (url.pathname === "/v1/wpra/standings") {
        return cached(
          request,
          env,
          ctx,
          () => getWpraStandings(url, env),
          "WPRA_STANDINGS_CACHE_TTL_SECONDS",
          secondsUntilNextCentralRefresh({ weekday: 1, hour: 8, minute: 30 })
        );
      }

      if (url.pathname === "/v1/past-champions") {
        return cached(
          request,
          env,
          ctx,
          () => getPastChampions(env),
          "PAST_CHAMPIONS_CACHE_TTL_SECONDS",
          secondsUntilNextCentralRefresh({ month: 12, day: 15, hour: 12, minute: 0 })
        );
      }

      return json({ error: "Not found" }, 404);
    } catch (error) {
      console.error(error);
      return json({ error: "Internal server error" }, 500);
    }
  }
};

async function cached(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  fetcher: () => Promise<Response>,
  ttlEnvName: keyof Env = "CACHE_TTL_SECONDS",
  defaultTtl = 300
): Promise<Response> {
  const ttl = cacheTtl(env, ttlEnvName, defaultTtl);
  if (!Number.isFinite(ttl) || ttl <= 0) {
    return fetcher();
  }

  const cache = await caches.open("rodeo-data-api");
  const cacheKey = canonicalCacheRequest(request, env);
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const response = await fetcher();
  if (response.ok) {
    const cachedResponse = new Response(response.body, response);
    cachedResponse.headers.set("cache-control", cacheControl(env, ttl));
    ctx.waitUntil(cache.put(cacheKey, cachedResponse.clone()));
    return cachedResponse;
  }

  return response;
}

async function getWpraStandings(url: URL, env: Env): Promise<Response> {
  const seasonYear = numberParam(url, "season_year");
  const event = stringParam(url, "event")?.toUpperCase();
  const type = normalizeStandingType(stringParam(url, "type") ?? "world");
  const circuitId = numberParam(url, "circuit_id");

  if (!seasonYear || !event || !type) {
    return json({ error: "season_year, event, and type are required" }, 400);
  }

  if (type === "circuit" && !circuitId) {
    return json({ error: "circuit_id is required for circuit standings" }, 400);
  }

  const sql = getSql(env);

  try {
    const rows =
      type === "circuit"
        ? await sql`
          select
            s.id,
            coalesce(s.contestant_id, historical.contestant_id) as contestant_id,
            s.first_name,
            s.last_name,
            s.hometown,
            s.event,
            s.type,
            s.earnings,
            s.points,
            s.place,
            s.season_year,
            s.circuit_id,
            coalesce(s.photo_url, historical.photo_url) as photo_url
          from wpra_standings s
          left join lateral (
            select contestant_id, photo_url
            from wpra_standings h
            where h.event = s.event
              and lower(h.first_name) = lower(s.first_name)
              and lower(h.last_name) = lower(s.last_name)
              and (h.contestant_id is not null or h.photo_url is not null)
              and h.id <> s.id
            order by h.season_year desc, h.contestant_id nulls last, h.photo_url nulls last
            limit 1
          ) historical on true
          where s.season_year = ${seasonYear}
            and s.event = ${event}
            and s.type = ${type}
            and s.circuit_id = ${circuitId}
          order by s.place asc, s.earnings desc
        `
        : await sql`
          select
            s.id,
            coalesce(s.contestant_id, historical.contestant_id) as contestant_id,
            s.first_name,
            s.last_name,
            s.hometown,
            s.event,
            s.type,
            s.earnings,
            s.points,
            s.place,
            s.season_year,
            s.circuit_id,
            coalesce(s.photo_url, historical.photo_url) as photo_url
          from wpra_standings s
          left join lateral (
            select contestant_id, photo_url
            from wpra_standings h
            where h.event = s.event
              and lower(h.first_name) = lower(s.first_name)
              and lower(h.last_name) = lower(s.last_name)
              and (h.contestant_id is not null or h.photo_url is not null)
              and h.id <> s.id
            order by h.season_year desc, h.contestant_id nulls last, h.photo_url nulls last
            limit 1
          ) historical on true
          where s.season_year = ${seasonYear}
            and s.event = ${event}
            and s.type = ${type}
          order by s.place asc, s.earnings desc
        `;

    return json(rows);
  } catch (error) {
    return databaseError(error);
  }
}

async function getPrcaStandings(url: URL, env: Env): Promise<Response> {
  const seasonYear = numberParam(url, "season_year");
  const event = stringParam(url, "event")?.toUpperCase();
  const type = normalizeStandingType(stringParam(url, "type") ?? "world");
  const circuitId = numberParam(url, "circuit_id");
  const tourId = numberParam(url, "tour_id");

  if (!seasonYear || !event || !type) {
    return json({ error: "season_year, event, and type are required" }, 400);
  }

  if (type === "circuit" && !circuitId) {
    return json({ error: "circuit_id is required for circuit standings" }, 400);
  }

  if (type === "tour" && !tourId) {
    return json({ error: "tour_id is required for tour standings" }, 400);
  }

  const sql = getSql(env);

  try {
    const rows =
      type === "circuit"
        ? await sql`
          select
            s.contestant_id as "ContestantId",
            coalesce(c.first_name, '') as "FirstName",
            coalesce(c.last_name, '') as "LastName",
            c.nick_name as "NickName",
            coalesce(c.hometown, '') as "Hometown",
            c.image_315_url as "image_315_url",
            c.sidearm_photo_url as "SidearmPhotoUrl",
            s.event_abbrev as "Event",
            s.standing_type as "Type",
            s.earnings as "Earnings",
            s.points as "Points",
            s.place as "Place",
            s.standing_id as "StandingId",
            s.season_year as "SeasonYear",
            s.tour_id as "TourId",
            s.circuit_id as "CircuitId"
          from prca_standings s
          left join prca_contestants c on c.contestant_id = s.contestant_id
          where s.season_year = ${seasonYear}
            and s.event_abbrev = ${event}
            and s.standing_type = ${type}
            and s.circuit_id = ${circuitId}
          order by s.place asc, s.earnings desc
        `
        : type === "tour"
          ? await sql`
          select
            s.contestant_id as "ContestantId",
            coalesce(c.first_name, '') as "FirstName",
            coalesce(c.last_name, '') as "LastName",
            c.nick_name as "NickName",
            coalesce(c.hometown, '') as "Hometown",
            c.image_315_url as "image_315_url",
            c.sidearm_photo_url as "SidearmPhotoUrl",
            s.event_abbrev as "Event",
            s.standing_type as "Type",
            s.earnings as "Earnings",
            s.points as "Points",
            s.place as "Place",
            s.standing_id as "StandingId",
            s.season_year as "SeasonYear",
            s.tour_id as "TourId",
            s.circuit_id as "CircuitId"
          from prca_standings s
          left join prca_contestants c on c.contestant_id = s.contestant_id
          where s.season_year = ${seasonYear}
            and s.event_abbrev = ${event}
            and s.standing_type = ${type}
            and s.tour_id = ${tourId}
          order by s.place asc, s.earnings desc
        `
        : await sql`
          select
            s.contestant_id as "ContestantId",
            coalesce(c.first_name, '') as "FirstName",
            coalesce(c.last_name, '') as "LastName",
            c.nick_name as "NickName",
            coalesce(c.hometown, '') as "Hometown",
            c.image_315_url as "image_315_url",
            c.sidearm_photo_url as "SidearmPhotoUrl",
            s.event_abbrev as "Event",
            s.standing_type as "Type",
            s.earnings as "Earnings",
            s.points as "Points",
            s.place as "Place",
            s.standing_id as "StandingId",
            s.season_year as "SeasonYear",
            s.tour_id as "TourId",
            s.circuit_id as "CircuitId"
          from prca_standings s
          left join prca_contestants c on c.contestant_id = s.contestant_id
          where s.season_year = ${seasonYear}
            and s.event_abbrev = ${event}
            and s.standing_type = ${type}
          order by s.place asc, s.earnings desc
        `;

    return json({ data: rows });
  } catch (error) {
    return databaseError(error);
  }
}

async function getPrcaRodeos(url: URL, env: Env): Promise<Response> {
  const limit = boundedNumberParam(url, "limit", 100, 1, 200);
  const offset = boundedNumberParam(url, "offset", 0, 0, 10_000);
  const seasonYear = numberParam(url, "season_year") ?? numberParam(url, "year");
  const rodeoId = stringParam(url, "rodeo_id") ?? stringParam(url, "id");
  const query = stringParam(url, "q")?.toLowerCase() ?? null;
  const startDate = stringParam(url, "start_date");
  const endDate = stringParam(url, "end_date");
  const state = stringParam(url, "state")?.toUpperCase() ?? null;
  const latitude = decimalParam(url, "latitude") ?? decimalParam(url, "lat");
  const longitude = decimalParam(url, "longitude") ?? decimalParam(url, "lng") ?? decimalParam(url, "lon");
  const radiusMiles = boundedDecimalParam(url, "radius_miles", 50, 1, 500);
  const latDelta = latitude === null ? null : radiusMiles / 69;
  const lonDelta =
    latitude === null
      ? null
      : radiusMiles / Math.max(Math.cos((latitude * Math.PI) / 180) * 69, 1);
  const minLatitude = latitude === null || latDelta === null ? null : latitude - latDelta;
  const maxLatitude = latitude === null || latDelta === null ? null : latitude + latDelta;
  const minLongitude = longitude === null || lonDelta === null ? null : longitude - lonDelta;
  const maxLongitude = longitude === null || lonDelta === null ? null : longitude + lonDelta;

  if ((latitude === null) !== (longitude === null)) {
    return json({ error: "latitude and longitude must be provided together" }, 400);
  }

  const sql = getSql(env);

  try {
    if (!seasonYear && !rodeoId && !query && !startDate && !endDate && !state && latitude === null) {
      const rows = await sql`
        select *
        from prca_rodeos
        limit ${limit}
        offset ${offset}
      `;

      return json({ data: rows });
    }

    const rows = await sql`
      with rodeos as (
        select
          r.*,
          to_jsonb(r) as data
        from prca_rodeos r
      ),
      normalized as (
        select
          rodeos.*,
          coalesce(
            data->>'latitude',
            data->>'lat',
            data->>'venue_latitude',
            data->>'venue_lat',
            data->>'geo_latitude'
          ) as rodeo_latitude,
          coalesce(
            data->>'longitude',
            data->>'lng',
            data->>'lon',
            data->>'venue_longitude',
            data->>'venue_lng',
            data->>'geo_longitude'
          ) as rodeo_longitude
        from rodeos
      ),
      located as (
        select
          normalized.*,
          case
            when rodeo_latitude ~ '^-?[0-9]+(\.[0-9]+)?$'
             and rodeo_longitude ~ '^-?[0-9]+(\.[0-9]+)?$'
            then (
              3958.7613 * 2 * asin(
                sqrt(
                  power(sin(radians((rodeo_latitude::double precision - ${latitude ?? 0}) / 2)), 2)
                  + cos(radians(${latitude ?? 0}))
                  * cos(radians(rodeo_latitude::double precision))
                  * power(sin(radians((rodeo_longitude::double precision - ${longitude ?? 0}) / 2)), 2)
                )
              )
            )
            else null
          end as distance_miles
        from normalized
      )
      select
        data ||
          case
            when ${latitude}::double precision is null then '{}'::jsonb
            else jsonb_build_object('distance_miles', distance_miles)
          end as rodeo
      from located
      where (${seasonYear?.toString() ?? null}::text is null
          or data->>'season_year' = ${seasonYear?.toString() ?? null}
          or data->>'year' = ${seasonYear?.toString() ?? null})
        and (${rodeoId}::text is null
          or data->>'rodeo_id' = ${rodeoId}
          or data->>'id' = ${rodeoId})
        and (${state}::text is null
          or upper(coalesce(data->>'state', data->>'state_abbrev', '')) = ${state})
        and (${startDate}::text is null
          or coalesce(
            data->>'start_date',
            data->>'rodeo_start_date',
            data->>'performance_date',
            data->>'date',
            ''
          ) >= ${startDate ?? ""})
        and (${endDate}::text is null
          or coalesce(
            data->>'end_date',
            data->>'rodeo_end_date',
            data->>'performance_date',
            data->>'date',
            ''
          ) <= ${endDate ?? ""})
        and (${query}::text is null
          or lower(coalesce(data->>'name', '')) like ${query ? `%${query}%` : null}
          or lower(coalesce(data->>'rodeo_name', '')) like ${query ? `%${query}%` : null}
          or lower(coalesce(data->>'city', '')) like ${query ? `%${query}%` : null}
          or lower(coalesce(data->>'location', '')) like ${query ? `%${query}%` : null})
        and (${latitude}::double precision is null
          or (
            rodeo_latitude ~ '^-?[0-9]+(\.[0-9]+)?$'
            and rodeo_longitude ~ '^-?[0-9]+(\.[0-9]+)?$'
            and rodeo_latitude::double precision between ${minLatitude ?? 0} and ${maxLatitude ?? 0}
            and rodeo_longitude::double precision between ${minLongitude ?? 0} and ${maxLongitude ?? 0}
          ))
        and (${latitude}::double precision is null or distance_miles <= ${radiusMiles})
      order by
        case when ${latitude}::double precision is null then 1 else 0 end asc,
        distance_miles asc nulls last,
        nullif(coalesce(
          data->>'start_date',
          data->>'rodeo_start_date',
          data->>'performance_date',
          data->>'date',
          ''
        ), '') asc nulls last,
        coalesce(data->>'name', data->>'rodeo_name', '') asc
      limit ${limit}
      offset ${offset}
    `;

    return json({ data: rows.map((row) => (row as { rodeo: unknown }).rodeo) });
  } catch (error) {
    return databaseError(error);
  }
}

async function getPastChampions(env: Env): Promise<Response> {
  const sql = getSql(env);

  try {
    const rows = await sql`
      select id, year, event, athlete, hometown
      from past_champions
      order by year desc, event asc, athlete asc
    `;

    return json(rows);
  } catch (error) {
    return databaseError(error);
  }
}

async function getDatabaseSchema(env: Env): Promise<Response> {
  const sql = getSql(env);

  try {
    const tables = await sql`
      select
        c.table_schema,
        c.table_name,
        c.column_name,
        c.ordinal_position,
        c.data_type,
        c.udt_name,
        c.is_nullable = 'YES' as is_nullable,
        c.column_default,
        coalesce(pg_class.reltuples::bigint, 0) as estimated_rows
      from information_schema.columns c
      left join pg_namespace
        on pg_namespace.nspname = c.table_schema
      left join pg_class
        on pg_class.relnamespace = pg_namespace.oid
       and pg_class.relname = c.table_name
       and pg_class.relkind in ('r', 'p', 'v', 'm')
      where c.table_schema not in ('information_schema', 'pg_catalog')
        and c.table_schema not like 'pg_toast%'
      order by c.table_schema, c.table_name, c.ordinal_position
    `;

    return json({
      tables: groupSchemaRows(tables as SchemaColumnRow[])
    });
  } catch (error) {
    return databaseError(error);
  }
}

async function checkDatabase(env: Env): Promise<Response> {
  if (!env.DATABASE_URL) {
    return json({ ok: false, error: "DATABASE_URL secret is missing" }, 500);
  }

  try {
    const sql = getSql(env);
    const rows = await sql`select 1 as ok`;
    return json({ ok: true, result: rows[0] ?? null });
  } catch (error) {
    return databaseError(error);
  }
}

function getSql(env: Env) {
  if (!env.DATABASE_URL) {
    throw new Error("DATABASE_URL secret is missing");
  }

  return neon(env.DATABASE_URL);
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: jsonHeaders
  });
}

function databaseError(error: unknown): Response {
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

function cacheTtl(env: Env, ttlEnvName: keyof Env, defaultTtl: number): number {
  const endpointTtl = Number(env[ttlEnvName]);
  if (Number.isFinite(endpointTtl)) return endpointTtl;

  if (ttlEnvName === "CACHE_TTL_SECONDS") {
    const globalTtl = Number(env.CACHE_TTL_SECONDS);
    return Number.isFinite(globalTtl) ? globalTtl : defaultTtl;
  }

  return defaultTtl;
}

function cacheControl(env: Env, ttl: number): string {
  const staleWhileRevalidate = Number(env.CACHE_STALE_WHILE_REVALIDATE_SECONDS ?? ttl * 2);
  const directives = [`public`, `max-age=${ttl}`, `s-maxage=${ttl}`];

  if (Number.isFinite(staleWhileRevalidate) && staleWhileRevalidate > 0) {
    directives.push(`stale-while-revalidate=${staleWhileRevalidate}`);
  }

  return directives.join(", ");
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

function secondsUntilNextCentralRefresh(schedule: CentralRefreshSchedule, now = new Date()): number {
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

function stringParam(url: URL, name: string): string | null {
  const raw = url.searchParams.get(name);
  const trimmed = raw?.trim();
  return trimmed ? trimmed : null;
}

function numberParam(url: URL, name: string): number | null {
  const raw = stringParam(url, name);
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isInteger(parsed) ? parsed : null;
}

function decimalParam(url: URL, name: string): number | null {
  const raw = stringParam(url, name);
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function boundedNumberParam(
  url: URL,
  name: string,
  fallback: number,
  min: number,
  max: number
): number {
  const value = numberParam(url, name) ?? fallback;
  return Math.min(Math.max(value, min), max);
}

function boundedDecimalParam(
  url: URL,
  name: string,
  fallback: number,
  min: number,
  max: number
): number {
  const value = decimalParam(url, name) ?? fallback;
  return Math.min(Math.max(value, min), max);
}

type SchemaColumnRow = {
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

function groupSchemaRows(rows: SchemaColumnRow[]) {
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

function normalizeStandingType(value: string): StandingType | null {
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
