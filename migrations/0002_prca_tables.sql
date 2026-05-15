create table if not exists prca_contestants (
  contestant_id bigint primary key,
  first_name text,
  last_name text,
  nick_name text,
  hometown text,
  image_315_url text,
  sidearm_photo_url text,
  inserted_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists prca_standings (
  standing_id bigint primary key,
  contestant_id bigint,
  event_abbrev text not null,
  standing_type text not null,
  earnings numeric(12, 2) not null default 0,
  points numeric(12, 2) not null default 0,
  place integer not null,
  season_year integer not null,
  tour_id integer,
  circuit_id integer,
  inserted_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists prca_standings_lookup_idx
  on prca_standings (season_year, event_abbrev, standing_type, circuit_id, tour_id, place);

create index if not exists prca_standings_contestant_idx
  on prca_standings (contestant_id);
