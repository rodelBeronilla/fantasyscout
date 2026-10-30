{#
  ESPN fantasy's market per player, from the latest landing per league, typed. An ESPN player
  rostered in no league has a null share; the WNBA's average draft position out of season is one
  placeholder for everybody, which gold leaves out of the market rank.
#}

with latest as (

    select *
    from {{ ref('espn_fantasy_players') }}
    where espn_player_id is not null
    qualify _ingest_date = max(_ingest_date) over (partition by league)

)

select
    league || ':' || espn_player_id as market_key,
    league,
    season,
    espn_player_id,
    full_name,
    espn_team_id,
    try_cast(percent_owned as double) as percent_owned,
    try_cast(percent_started as double) as percent_started,
    try_cast(average_draft_position as double) as average_draft_position,
    try_cast(auction_value_average as double) as auction_value_average,
    try_cast(percent_owned_change as double) as percent_owned_change,
    try_cast(espn_rank_standard as integer) as espn_rank_standard,
    try_cast(espn_rank_roto as integer) as espn_rank_roto,
    cast(_ingest_date as date) as observed_date
from latest
qualify row_number() over (partition by league, espn_player_id order by _source_file desc) = 1
