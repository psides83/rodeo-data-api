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

`GET /v1/monthly-money-earners?month=2026-08&event=BB`

Returns cached monthly top money earners for one event under `{ "month": "2026-08", "event": "BB", "updated_at": "...", "data": [...] }`.

`GET /v1/monthly-money-earners/overall?month=2026-08`

Returns cached monthly top money earners across all events under `{ "month": "2026-08", "updated_at": "...", "data": [...] }`.

`POST /v1/admin/monthly-money-earners/backfill?year=2026&limit=5`

Runs one protected backfill batch for completed rodeos in the requested year, defaulting to the current year. It skips rodeos already tracked in `monthly_money_processed_rodeos`, waits between result API calls, and returns counts plus remaining unprocessed rodeos. Send `Authorization: Bearer <ADMIN_API_KEY>` or `x-api-key: <ADMIN_API_KEY>`.

`GET /v1/admin/monthly-money-earners/backfill/status?year=2026`

Returns the latest monthly money runs, how many completed rodeos are still unprocessed for that year, and the most recently processed rodeos. Use this while a backfill is running to see progress between batches.

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

The Worker caches successful read responses at the Cloudflare edge before hitting Neon. PRCA standings are not cached; every `/v1/standings` and `/v1/prca/standings` request is proxied directly to ProRodeo.

By default, WPRA standings cache until the next Monday, Wednesday, or Friday 8:30 AM Central refresh window. Past champions cache until the next December 15 noon Central update window.

Optional fixed-TTL overrides:

`WPRA_STANDINGS_CACHE_TTL_SECONDS`, `RODEOS_CACHE_TTL_SECONDS`, `MONTHLY_MONEY_CACHE_TTL_SECONDS`, `PAST_CHAMPIONS_CACHE_TTL_SECONDS`, `SCHEMA_CACHE_TTL_SECONDS`, and `CACHE_STALE_WHILE_REVALIDATE_SECONDS`.

## Monthly Money Earners

Monthly money collection is currently paused. The Worker has a scheduled handler, but it does not run the monthly money refresh while this feature is tabled.

When enabled, the monthly money flow reads completed rodeos from `prca_rodeos`, skips rodeos already tracked in `monthly_money_processed_rodeos`, calls the configured result URL for each missing completed rodeo, stores compact paid-contestant rows from the JSON `Winners` array in `monthly_money_rodeo_results`, and rebuilds the top-20 cache tables from those compact rows.

Completed means the rodeo data object is not tagged with a status containing `in progress`. `MONTHLY_MONEY_REFRESH_EVENTS` limits result rows to a comma-separated event list. `MONTHLY_MONEY_RODEO_LIMIT` caps how many new completed rodeos are called in one scheduled run. `MONTHLY_MONEY_BACKFILL_RODEO_LIMIT` caps each one-time backfill request. Both caps are limited to 10 per invocation to stay under Cloudflare subrequest limits. `MONTHLY_MONEY_REQUEST_DELAY_MS` adds a delay between result API calls for both weekly and backfill runs.

The scraper uses the same public ProRodeo base URL as PRCA standings and calls `/rodeo?id=<rodeoId>` for each completed rodeo. Override `PRCA_API_BASE` only if that upstream base URL changes. It does not parse `ApResults`; earnings, contestant IDs, hometowns, and image URLs are expected to come from `Winners[].Contestant`.

For the one-time catch-up, deploy with `ADMIN_API_KEY` set and call `/v1/admin/monthly-money-earners/backfill?year=2026` repeatedly until `remaining_rodeos_count` is `0`. Each call processes only one capped, delayed batch.

While a catch-up is running, call `/v1/admin/monthly-money-earners/backfill/status?year=2026` with the same admin authorization to see the current run message, recent processed rodeos, and remaining count. Cloudflare logs also include one line per rodeo fetch, save, failure, wait, and cache rebuild step.

To run the catch-up from your terminal with progress output:

```sh
npm run backfill:monthly-money -- --year=2026
```

The terminal runner reads `ADMIN_API_KEY` from `.dev.vars`, `.env`, or your shell environment. It prints each batch, the remaining rodeo count, and the most recent rodeos after every batch. Use `--max-batches=10` to stop after a fixed number of batches. Use `--retry-empty` to reprocess rodeos that previously saved 0 result rows. Use `--retry-bad-text` to repair AP fallback rows that accidentally saved scores or times in contestant IDs. Use `--retry-all` only when you intentionally want to reprocess already processed rows.

The SQL files in `migrations/` are not automatically applied just because the repo is pushed unless your deployment pipeline explicitly runs them against Neon. For the current setup documented here, run the new migration against Neon before deploying the Worker code that uses these tables.

To force the Worker Cache API to read fresh data after a manual Neon update, bump `CACHE_VERSION` in `wrangler.toml` and deploy. If Cloudflare already cached an exact public URL, purge that URL in the Cloudflare dashboard once.

## Notes

The Worker intentionally returns the same JSON field names as the existing Supabase tables. That keeps the app migration small: the iOS client can change base URL and query shape without remapping every field at once.
