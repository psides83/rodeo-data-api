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

## Notes

The Worker intentionally returns the same JSON field names as the existing Supabase tables. That keeps the app migration small: the iOS client can change base URL and query shape without remapping every field at once.
