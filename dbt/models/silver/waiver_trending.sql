{#
  Sleeper's trending players from the newest landing (NBA): one row per player in the most-added
  or most-dropped lists, with the leagues adding and dropping the player over the lookback window
  and the player's rank in each list (1 is the most). Sleeper's name, team and birth date come from its
  newest directory, for gold to link the player to the league's id.
#}

with latest as (

    select *
    from {{ ref('sleeper_trending') }}
    where sleeper_player_id is not null
    qualify request_key = max(request_key) over (partition by league)

),

ranked as (

    select
        league,
        season,
        request_key,
        sleeper_player_id,
        direction,
        try_cast(move_count as bigint) as move_count,
        try_cast(lookback_hours as integer) as lookback_hours,
        row_number() over (partition by league, direction order by try_cast(move_count as bigint) desc, sleeper_player_id) as direction_rank
    from latest

),

players as (

    select *
    from {{ ref('sleeper_players') }}
    where sleeper_player_id is not null
    qualify row_number() over (partition by league, sleeper_player_id order by request_key desc, _source_file desc) = 1

)

select
    r.league || ':' || r.sleeper_player_id as waiver_trending_key,
    r.league,
    max(r.season) as season,
    r.sleeper_player_id,
    max(p.full_name) as full_name,
    max(p.search_full_name) as search_full_name,
    max(p.team_abbreviation) as team_abbreviation,
    max(try_cast(p.birth_date as date)) as birth_date,
    cast(coalesce(sum(case when r.direction = 'add' then r.move_count end), 0) as bigint) as adds,
    cast(coalesce(sum(case when r.direction = 'drop' then r.move_count end), 0) as bigint) as drops,
    min(case when r.direction = 'add' then r.direction_rank end) as add_rank,
    min(case when r.direction = 'drop' then r.direction_rank end) as drop_rank,
    max(r.lookback_hours) as lookback_hours,
    max(r.request_key) as observed_key
from ranked as r
left join players as p on p.league = r.league and p.sleeper_player_id = r.sleeper_player_id
group by r.league, r.sleeper_player_id
