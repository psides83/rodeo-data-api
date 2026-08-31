create table if not exists monthly_event_money_earners (
  month date not null,
  event text not null,
  contestant_id text not null,
  name text not null,
  hometown text not null default '',
  image_url text,
  earnings numeric(12, 2) not null default 0,
  rodeos_count integer not null default 0,
  rank integer not null,
  updated_at timestamptz not null default now(),
  primary key (month, event, contestant_id)
);

create index if not exists monthly_event_money_earners_lookup_idx
  on monthly_event_money_earners (month desc, event, rank);

create table if not exists monthly_overall_money_earners (
  month date not null,
  contestant_id text not null,
  name text not null,
  hometown text not null default '',
  image_url text,
  earnings numeric(12, 2) not null default 0,
  events_count integer not null default 0,
  rodeos_count integer not null default 0,
  rank integer not null,
  updated_at timestamptz not null default now(),
  primary key (month, contestant_id)
);

create index if not exists monthly_overall_money_earners_lookup_idx
  on monthly_overall_money_earners (month desc, rank);

create table if not exists monthly_money_rodeo_results (
  rodeo_id text not null,
  month date not null,
  event text not null,
  contestant_id text not null,
  name text not null,
  hometown text not null default '',
  image_url text,
  earnings numeric(12, 2) not null default 0,
  processed_at timestamptz not null default now(),
  primary key (rodeo_id, event, contestant_id)
);

create index if not exists monthly_money_rodeo_results_month_event_idx
  on monthly_money_rodeo_results (month desc, event, earnings desc);

create index if not exists monthly_money_rodeo_results_month_contestant_idx
  on monthly_money_rodeo_results (month desc, contestant_id);

create table if not exists monthly_money_processed_rodeos (
  rodeo_id text primary key,
  rodeo_name text,
  month date,
  status text not null,
  processed_at timestamptz not null default now(),
  result_rows_count integer not null default 0,
  error_message text
);

create index if not exists monthly_money_processed_rodeos_status_idx
  on monthly_money_processed_rodeos (status, processed_at desc);

create table if not exists monthly_event_money_runs (
  id bigserial primary key,
  month date not null,
  event text,
  status text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  source_rodeos_count integer not null default 0,
  error_message text
);

create index if not exists monthly_event_money_runs_lookup_idx
  on monthly_event_money_runs (month desc, event, started_at desc);
