{#
  Each player's current status, one row per player with one. The league's official injury
  report wins for the next game it covers (it is filed by the teams, several times a day);
  otherwise ESPN's injury listing (fct_availability). The official report speaks only to the
  next game, so the ESPN listing's own status, expected return and news stay alongside for the
  rest of the season: the board's availability multiplier reads espn_status_group, not status.

  Official rows are linked to the league player id by name within the team, the team by its
  full name. An official "Available" clears the status for that game.
#}

with official_rows as (

    select o.*
    from {{ ref('official_injury_report') }} as o
    where o.is_latest and not o.not_submitted and o.player_name is not null
        and o.game_date >= {{ eastern_today() }}

),

team_names as (

    select league, team_id, lower(replace(team_name, ' ', '')) as team_key
    from {{ ref('teams') }}
    qualify row_number() over (partition by league, team_id order by season desc) = 1

),

players as (

    select league, stats_player_id, team_id, {{ norm_name('full_name') }} as name_key
    from {{ ref('dim_player') }}
    where is_current

),

official as (

    select
        o.league,
        p.stats_player_id,
        o.status as official_status,
        o.reason as official_reason,
        o.reason_group as official_reason_group,
        o.injury_detail as official_detail,
        o.game_date as official_game_date,
        o.matchup as official_matchup,
        o.published_at_et as official_report_at
    from official_rows as o
    join team_names as t on t.league = o.league and t.team_key = lower(replace(o.team, ' ', ''))
    join players as p on p.league = o.league and p.team_id = t.team_id and p.name_key = {{ norm_name('o.player_name') }}
    -- the next game the report covers
    qualify row_number() over (partition by o.league, p.stats_player_id order by o.game_date, o.matchup) = 1

),

espn as (

    select league, stats_player_id, status, status_group, injury_type, expected_return, short_comment,
        long_comment, status_since
    from {{ ref('fct_availability') }}
    where is_current and stats_player_id is not null
    qualify row_number() over (
        partition by league, stats_player_id
        order by case status_group when 'out' then 0 when 'doubtful' then 1 when 'questionable' then 2 when 'day_to_day' then 3 else 4 end
    ) = 1

),

ids as (

    select league, stats_player_id from official
    union
    select league, stats_player_id from espn

)

select
    {{ sk(['i.league', 'i.stats_player_id']) }} as player_status_sk,
    i.league,
    i.stats_player_id,
    coalesce(o.official_status, e.status) as status,
    case
        when o.official_status is null then e.status_group
        when o.official_status = 'Out' then 'out'
        when o.official_status = 'Doubtful' then 'doubtful'
        when o.official_status = 'Questionable' then 'questionable'
        when o.official_status = 'Probable' then 'probable'
        else null
    end as status_group,
    case when o.official_status is not null then 'official' else 'espn' end as status_source,
    coalesce(o.official_detail, e.injury_type) as injury_type,
    e.expected_return,
    coalesce(o.official_reason, e.short_comment) as short_comment,
    e.long_comment,
    e.status_since,
    e.status as espn_status,
    e.status_group as espn_status_group,
    o.official_status,
    o.official_reason,
    o.official_reason_group,
    o.official_game_date,
    o.official_matchup,
    o.official_report_at
from ids as i
left join official as o on o.league = i.league and o.stats_player_id = i.stats_player_id
left join espn as e on e.league = i.league and e.stats_player_id = i.stats_player_id
