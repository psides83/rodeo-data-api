import { neon } from "@neondatabase/serverless";

type Env = {
  DATABASE_URL: string;
  CACHE_TTL_SECONDS?: string;
};

type StandingType =
  | "world"
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
            id,
            contestant_id,
            first_name,
            last_name,
            hometown,
            event,
            type,
            earnings,
            points,
            place,
            season_year,
            circuit_id,
            photo_url
          from wpra_standings
          where season_year = ${seasonYear}
            and event = ${event}
            and type = ${type}
            and circuit_id = ${circuitId}
          order by place asc, earnings desc
        `
        : await sql`
          select
            id,
            contestant_id,
            first_name,
            last_name,
            hometown,
            event,
            type,
            earnings,
            points,
            place,
            season_year,
            circuit_id,
            photo_url
          from wpra_standings
          where season_year = ${seasonYear}
            and event = ${event}
            and type = ${type}
          order by place asc, earnings desc
        `;

    return json(rows);
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

function normalizeStandingType(value: string): StandingType | null {
  const cleaned = value.trim().toLowerCase().replace(/\s+/g, "");
  if (cleaned.includes("world")) return "world";
  if (cleaned.includes("circuit")) return "circuit";
  if (cleaned.includes("rookie")) return "rookie";
  if (cleaned.includes("permit")) return "permit";
  if (cleaned.includes("xtremebull") || cleaned.includes("xbull")) return "xtremebulls";
  if (cleaned.includes("xtremebronc") || cleaned.includes("xbronc")) return "xtremebroncs";
  if (cleaned.includes("legacy")) return "legacysteerroping";

  const allowed = new Set<StandingType>([
    "world",
    "circuit",
    "rookie",
    "permit",
    "xtremebulls",
    "xtremebroncs",
    "legacysteerroping"
  ]);

  return allowed.has(cleaned as StandingType) ? (cleaned as StandingType) : null;
}
