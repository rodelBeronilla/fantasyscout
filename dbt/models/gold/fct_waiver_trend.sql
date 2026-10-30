{#
  Waiver heat from Sleeper (NBA): the players Sleeper leagues added and dropped most over the
  last day, linked to the league player id. Sleeper names players by its own id, so a trending
  player is matched to a current league player by name: Sleeper's ASCII search name against the
  league name with its suffix kept, or both names without suffixes. A matching birth date, then
  a matching team, picks between namesakes; a name that still matches more than one player is
  left unlinked.
  - waiver_trend: adding when more leagues added than dropped him, else dropping.
#}

with trending as (

    select * from {{ ref('waiver_trending') }}

),

team_names as (

    select league, team_id, abbreviation
    from {{ ref('teams') }}
    qualify row_number() over (partition by league, team_id order by season desc) = 1

),

ours as (

    select
        p.league,
        p.stats_player_id,
        p.birth_date,
        t.abbreviation as team_abbreviation,
        {{ norm_name('p.full_name', keep_suffix=true) }} as name_full,
        {{ norm_name('p.full_name') }} as name_plain
    from {{ ref('dim_player') }} as p
    left join team_names as t on t.league = p.league and t.team_id = p.team_id
    where p.is_current

),

candidates as (

    select
        tr.league,
        tr.sleeper_player_id,
        o.stats_player_id,
        (case when o.birth_date = tr.birth_date then 2 else 0 end)
            + (case when o.team_abbreviation = tr.team_abbreviation then 1 else 0 end) as score
    from trending as tr
    join ours as o
        on o.league = tr.league
        and (o.name_full = tr.search_full_name or o.name_plain = {{ norm_name('tr.full_name') }})

),

best as (

    select
        league,
        sleeper_player_id,
        stats_player_id,
        score,
        count(*) over (partition by league, sleeper_player_id, score) as tied,
        row_number() over (partition by league, sleeper_player_id order by score desc, stats_player_id) as rn
    from candidates

)

select
    {{ sk(['tr.league', 'tr.sleeper_player_id']) }} as waiver_trend_sk,
    tr.league,
    b.stats_player_id,
    tr.sleeper_player_id,
    tr.full_name as sleeper_full_name,
    tr.adds,
    tr.drops,
    tr.adds - tr.drops as net_adds,
    tr.add_rank,
    tr.drop_rank,
    case when tr.adds > tr.drops then 'adding' else 'dropping' end as waiver_trend,
    tr.lookback_hours,
    tr.observed_key
from trending as tr
left join best as b
    on b.league = tr.league and b.sleeper_player_id = tr.sleeper_player_id and b.rn = 1 and b.tied = 1
