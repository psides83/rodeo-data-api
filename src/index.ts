import { neon } from "@neondatabase/serverless";

type Env = {
  DATABASE_URL: string;
  CACHE_TTL_SECONDS?: string;
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
        return cached(request, env, ctx, () => getDatabaseSchema(env));
      }

      if (url.pathname === "/v1/standings" || url.pathname === "/v1/prca/standings") {
        return cached(request, env, ctx, () => getPrcaStandings(url, env));
      }

      if (url.pathname === "/v1/prca/rodeos" || url.pathname === "/v1/rodeos") {
        return cached(request, env, ctx, () => getPrcaRodeos(url, env));
      }

      if (url.pathname === "/v1/wpra/standings") {
        return cached(request, env, ctx, () => getWpraStandings(url, env));
      }

      if (url.pathname === "/v1/past-champions") {
        return cached(request, env, ctx, () => getPastChampions(env));
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
  fetcher: () => Promise<Response>
): Promise<Response> {
  const ttl = Number(env.CACHE_TTL_SECONDS ?? "300");
  if (!Number.isFinite(ttl) || ttl <= 0) {
    return fetcher();
  }

  const cache = await caches.open("rodeo-data-api");
  const cacheKey = new Request(request.url, { method: "GET" });
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const response = await fetcher();
  if (response.ok) {
    const cachedResponse = new Response(response.body, response);
    cachedResponse.headers.set("cache-control", `public, max-age=${ttl}`);
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

  const sql = getSql(env);

  try {
    const rows = await sql`
      select r.*
      from prca_rodeos r
      where (${seasonYear?.toString() ?? null}::text is null
          or to_jsonb(r)->>'season_year' = ${seasonYear?.toString() ?? null}
          or to_jsonb(r)->>'year' = ${seasonYear?.toString() ?? null})
        and (${rodeoId}::text is null
          or to_jsonb(r)->>'rodeo_id' = ${rodeoId}
          or to_jsonb(r)->>'id' = ${rodeoId})
        and (${state}::text is null
          or upper(coalesce(to_jsonb(r)->>'state', to_jsonb(r)->>'state_abbrev', '')) = ${state})
        and (${startDate}::text is null
          or coalesce(
            to_jsonb(r)->>'start_date',
            to_jsonb(r)->>'rodeo_start_date',
            to_jsonb(r)->>'performance_date',
            to_jsonb(r)->>'date',
            ''
          ) >= ${startDate ?? ""})
        and (${endDate}::text is null
          or coalesce(
            to_jsonb(r)->>'end_date',
            to_jsonb(r)->>'rodeo_end_date',
            to_jsonb(r)->>'performance_date',
            to_jsonb(r)->>'date',
            ''
          ) <= ${endDate ?? ""})
        and (${query}::text is null
          or lower(coalesce(to_jsonb(r)->>'name', '')) like ${query ? `%${query}%` : null}
          or lower(coalesce(to_jsonb(r)->>'rodeo_name', '')) like ${query ? `%${query}%` : null}
          or lower(coalesce(to_jsonb(r)->>'city', '')) like ${query ? `%${query}%` : null}
          or lower(coalesce(to_jsonb(r)->>'location', '')) like ${query ? `%${query}%` : null})
      order by
        nullif(coalesce(
          to_jsonb(r)->>'start_date',
          to_jsonb(r)->>'rodeo_start_date',
          to_jsonb(r)->>'performance_date',
          to_jsonb(r)->>'date',
          ''
        ), '') asc nulls last,
        coalesce(to_jsonb(r)->>'name', to_jsonb(r)->>'rodeo_name', '') asc
      limit ${limit}
      offset ${offset}
    `;

    return json({ data: rows });
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
