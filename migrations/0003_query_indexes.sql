create index if not exists prca_standings_world_lookup_idx
  on prca_standings (season_year, event_abbrev, standing_type, place, earnings desc);

create index if not exists prca_standings_circuit_lookup_idx
  on prca_standings (season_year, event_abbrev, standing_type, circuit_id, place, earnings desc);

create index if not exists prca_standings_tour_lookup_idx
  on prca_standings (season_year, event_abbrev, standing_type, tour_id, place, earnings desc);

create index if not exists wpra_standings_historical_asset_lookup_idx
  on wpra_standings (event, lower(first_name), lower(last_name), season_year desc)
  where contestant_id is not null or photo_url is not null;

create index if not exists wpra_standings_world_lookup_idx
  on wpra_standings (season_year, event, type, place, earnings desc);

create index if not exists wpra_standings_circuit_lookup_idx
  on wpra_standings (season_year, event, type, circuit_id, place, earnings desc);
