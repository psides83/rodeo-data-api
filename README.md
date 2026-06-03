# Rodeo Data API

Cloudflare Worker API for RodeoDaily read-heavy data backed by Neon Postgres.

## Endpoints

`GET /health`

Returns a simple health payload.

`GET /v1/db-check`

Checks whether the Worker can connect to Neon.

`GET /v1/schema`

Returns the current non-system Neon schemas, tables, columns, types, defaults, nullability, and estimated row counts. Use this after schema changes to see what the API can read from Neon.

`GET /v1/prca/standings?season_year=2026&event=BB&type=world`

Returns PRCA standings rows under a `{ "data": [...] }` envelope.

`GET /v1/prca/rodeos?season_year=2026&state=TX&limit=100`

Returns PRCA rodeos from `prca_rodeos` under a `{ "data": [...] }` envelope. Optional filters: `season_year` or `year`, `state`, `rodeo_id` or `id`, `start_date`, `end_date`, `q`, `latitude` or `lat`, `longitude` or `lng` or `lon`, `radius_miles`, `limit`, and `offset`.

For nearby rodeos:

`GET /v1/prca/rodeos?lat=32.7767&lng=-96.7970&radius_miles=100`

For PRCA circuit and tour standings:

`GET /v1/prca/standings?season_year=2026&event=BB&type=circuit&circuit_id=1`

`GET /v1/prca/standings?season_year=2026&event=BB&type=tour&tour_id=1`

`GET /v1/wpra/standings?season_year=2026&event=GB&type=world`

Returns rows shaped like the current Supabase `standings` REST response.

For circuit standings:

`GET /v1/wpra/standings?season_year=2026&event=GB&type=circuit&circuit_id=1`

`GET /v1/past-champions`

Returns rows shaped like the current Supabase `past_champions` REST response.

## Setup

1. Create a Neon database.
2. Run the SQL files in `migrations/` against Neon in filename order.
3. Copy `.dev.vars.example` to `.dev.vars`.
4. Set `DATABASE_URL` to the Neon pooled connection string.
5. Run `npm install`.
6. Run `npm run dev`.

For deployment, set the secret:

```sh
wrangler secret put DATABASE_URL
```

Then deploy:

```sh
npm run deploy
```

## Cache tuning

The Worker caches successful read responses at the Cloudflare edge before hitting Neon. `CACHE_TTL_SECONDS` is the global fallback. Endpoint-specific overrides:

`STANDINGS_CACHE_TTL_SECONDS`, `RODEOS_CACHE_TTL_SECONDS`, `PAST_CHAMPIONS_CACHE_TTL_SECONDS`, `SCHEMA_CACHE_TTL_SECONDS`, and `CACHE_STALE_WHILE_REVALIDATE_SECONDS`.

## Notes

The Worker intentionally returns the same JSON field names as the existing Supabase tables. That keeps the app migration small: the iOS client can change base URL and query shape without remapping every field at once.
