import {
  type Env,
  type SchemaColumnRow,
  type StandingType,
  boundedDecimalParam,
  boundedNumberParam,
  cached,
  clientResponse,
  databaseError,
  decimalParam,
  getSql,
  groupSchemaRows,
  json,
  jsonHeaders,
  normalizeStandingType,
  numberParam,
  secondsUntilNextCentralRefresh,
  stringParam
} from "./shared";
import {
  backfillMonthlyMoneyEarners,
  getMonthlyEventMoneyEarners,
  getMonthlyMoneyBackfillStatus,
  getMonthlyOverallMoneyEarners,
  refreshMonthlyMoneyEarners
} from "./monthlyMoney";

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

      if (url.pathname === "/v1/admin/monthly-money-earners/backfill") {
        if (request.method !== "POST") {
          return json({ error: "Method not allowed" }, 405);
        }

        if (!isAuthorizedAdmin(request, env)) {
          return json({ error: "Unauthorized" }, 401);
        }

        const result = await backfillMonthlyMoneyEarners(url, env);
        return json(result);
      }

      if (url.pathname === "/v1/admin/monthly-money-earners/backfill/status") {
        if (request.method !== "GET") {
          return json({ error: "Method not allowed" }, 405);
        }

        if (!isAuthorizedAdmin(request, env)) {
          return json({ error: "Unauthorized" }, 401);
        }

        return getMonthlyMoneyBackfillStatus(url, env);
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
        return clientResponse(await getPrcaStandings(url, env), "BYPASS", env);
      }

      if (url.pathname === "/v1/prca/rodeos" || url.pathname === "/v1/rodeos") {
        return cached(request, env, ctx, () => getPrcaRodeos(url, env), "RODEOS_CACHE_TTL_SECONDS", 1800);
      }

      if (url.pathname === "/v1/monthly-money-earners") {
        return cached(
          request,
          env,
          ctx,
          () => getMonthlyEventMoneyEarners(url, env),
          "MONTHLY_MONEY_CACHE_TTL_SECONDS",
          secondsUntilNextCentralRefresh({ weekday: 1, hour: 8, minute: 0 })
        );
      }

      if (url.pathname === "/v1/monthly-money-earners/overall") {
        return cached(
          request,
          env,
          ctx,
          () => getMonthlyOverallMoneyEarners(url, env),
          "MONTHLY_MONEY_CACHE_TTL_SECONDS",
          secondsUntilNextCentralRefresh({ weekday: 1, hour: 8, minute: 0 })
        );
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
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    console.log("[monthly-money] Scheduled refresh is disabled while monthly money earners are tabled.");
  }
};

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

  try {
    const standingsUrl = buildPrcaStandingsUrl({ env, seasonYear, event, type, circuitId, tourId });
    const response = await fetch(standingsUrl, { cf: { cacheTtl: 0, cacheEverything: false } });
    const body = await response.text();

    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: {
        ...jsonHeaders,
        "cache-control": "no-store",
        "x-prca-source-url": standingsUrl
      }
    });
  } catch (error) {
    console.error(error);
    const message = error instanceof Error ? error.message : String(error);
    return json({ ok: false, error: "ProRodeo standings request failed", detail: message }, 502);
  }
}

function buildPrcaStandingsUrl(params: {
  env: Env;
  seasonYear: number;
  event: string;
  type: StandingType;
  circuitId: number | null;
  tourId: number | null;
}): string {
  const apiBase = (params.env.PRCA_API_BASE ?? "https://d1kfpvgfupbmyo.cloudfront.net/services/pro_rodeo.ashx").replace(
    /\/$/,
    ""
  );
  const scopeId = params.type === "circuit" ? params.circuitId : params.type === "tour" ? params.tourId : null;
  const searchParams = new URLSearchParams({
    year: String(params.seasonYear),
    type: params.type,
    id: scopeId === null ? "" : String(scopeId),
    event: params.event
  });

  return `${apiBase}/standings?${searchParams.toString()}`;
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

function isAuthorizedAdmin(request: Request, env: Env): boolean {
  if (!env.ADMIN_API_KEY) {
    return false;
  }

  const authorization = request.headers.get("authorization");
  const apiKey = request.headers.get("x-api-key");
  return authorization === `Bearer ${env.ADMIN_API_KEY}` || apiKey === env.ADMIN_API_KEY;
}
