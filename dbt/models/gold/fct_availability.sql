{#
  Player × report from ESPN's injury report, linked to the league player id.

  The injury feed names the athlete but carries no athlete id, so the link is made by name
  within the team: first to the ESPN roster (which has the athlete id) and through the player
  crosswalk to the league id; failing that, straight to the league player currently on that
  team (team crosswalk). is_current marks the rows of the latest report per league, the ones
  the board and streamers read; older listings stay for history. expected_return is a date when
  ESPN gives one.
#}

with injuries as (

    select
        i.*,
        {{ norm_name('i.athlete_name') }} as norm_name,
        i._ingest_date = max(i._ingest_date) over (partition by i.league) as is_current
    from {{ ref('injuries') }} as i

),

espn_roster as (

    select league, athlete_id, team_id, {{ norm_name('full_name') }} as norm_name
    from {{ ref('espn_roster_players') }}

),

via_roster as (

    select i.league, i.injury_id, r.athlete_id as espn_player_id
    from injuries as i
    join espn_roster as r
        on r.league = i.league and r.team_id = i.team_id and r.norm_name = i.norm_name
    qualify row_number() over (partition by i.league, i.injury_id order by r.athlete_id) = 1

),

league_players as (

    select p.league, p.stats_player_id, tx.espn_team_id, {{ norm_name('p.full_name') }} as norm_name
    from {{ ref('dim_player') }} as p
    join {{ ref('team_xwalk') }} as tx
        on tx.league = p.league and tx.stats_team_id = p.team_id
    where p.is_current

),

via_name as (

    select i.league, i.injury_id, lp.stats_player_id
    from injuries as i
    join league_players as lp
        on lp.league = i.league and lp.espn_team_id = i.team_id and lp.norm_name = i.norm_name
    qualify row_number() over (partition by i.league, i.injury_id order by lp.stats_player_id) = 1

)

select
    {{ sk(['i.league', "cast(i.report_date as string)", 'i.injury_id']) }} as availability_sk,
    i.league,
    i.season,
    i.report_date,
    i.injury_id,
    i.team_id as espn_team_id,
    i.team_name,
    coalesce(vr.espn_player_id, px_back.espn_player_id) as espn_player_id,
    i.athlete_name,
    coalesce(px.stats_player_id, vn.stats_player_id) as stats_player_id,
    i.status,
    case
        when lower(i.status) = 'out' then 'out'
        when lower(i.status) like 'day%' then 'day_to_day'
        when lower(i.status) like '%question%' then 'questionable'
        when lower(i.status) like '%doubt%' then 'doubtful'
        else 'other'
    end as status_group,
    i.injury_type,
    try_cast(substr(i.return_date, 1, 10) as date) as expected_return,
    i.short_comment,
    i.reported_date,
    i.is_current,
    'espn' as source,
    i._ingest_date
from injuries as i
left join via_roster as vr
    on vr.league = i.league and vr.injury_id = i.injury_id
left join {{ ref('player_xwalk') }} as px
    on px.league = i.league and px.espn_player_id = vr.espn_player_id
left join via_name as vn
    on vn.league = i.league and vn.injury_id = i.injury_id
left join {{ ref('player_xwalk') }} as px_back
    on px_back.league = i.league and px_back.stats_player_id = vn.stats_player_id
