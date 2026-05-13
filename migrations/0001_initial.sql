create table if not exists wpra_standings (
  id bigint primary key,
  contestant_id bigint,
  first_name text not null,
  last_name text not null,
  hometown text not null default '',
  event text not null,
  type text not null,
  earnings numeric(12, 2) not null default 0,
  points numeric(12, 2) not null default 0,
  place integer not null,
  season_year integer not null,
  circuit_id integer,
  photo_url text,
  source_updated_at timestamptz,
  inserted_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists wpra_standings_lookup_idx
  on wpra_standings (season_year, event, type, circuit_id, place);

create table if not exists past_champions (
  id text primary key,
  year integer not null,
  event text not null,
  athlete text not null,
  hometown text not null default '',
  inserted_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists past_champions_year_event_idx
  on past_champions (year desc, event, athlete);
