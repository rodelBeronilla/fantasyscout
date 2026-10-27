{#
  The draft and in-season board: one row per player per league for the latest season.

  Blend: last season 0.55, the season before 0.15, current season 0.30 rising to 0.80 as games
  accumulate (linear to 20 games); missing seasons hand their weight to the others. The nine
  category z-scores are blended the same way so punt variants can be summed in the app.
  Rest-of-season value scales the blend by the team's remaining share of the schedule and the
  availability multiplier (1.0 until the phase 4 crosswalk links injury reports to players).
#}

{% set zcols = ['z_points', 'z_rebounds_total', 'z_assists', 'z_steals', 'z_blocks', 'z_three_pointers_made', 'z_turnovers', 'z_field_goal_pct', 'z_free_throw_pct', 'z_total'] %}

with season_z as (

    select
        *,
        dense_rank() over (partition by league order by season desc) as season_rank
    from {{ ref('mart_category_zscores') }}
    where window_name = 'season'

),

current_season as (

    select league, season from season_z where season_rank = 1 group by league, season

),

players as (

    select league, player_id from season_z group by league, player_id

),

blended as (

    select
        p.league,
        cs.season,
        p.player_id,
        cur.games as games_current,
        cur.in_pool,
        -- weights
        0.30 + 0.50 * least(coalesce(cur.games, 0), 20) / 20.0 as w_cur_raw,
        cur.games is not null as has_cur,
        prev.games is not null as has_prev,
        prev2.games is not null as has_prev2,
        {%- for z in zcols %}
        cur.{{ z }} as cur_{{ z }},
        prev.{{ z }} as prev_{{ z }},
        prev2.{{ z }} as prev2_{{ z }}{{ "," if not loop.last }}
        {%- endfor %}
    from players as p
    join current_season as cs on cs.league = p.league
    left join season_z as cur on cur.league = p.league and cur.player_id = p.player_id and cur.season_rank = 1
    left join season_z as prev on prev.league = p.league and prev.player_id = p.player_id and prev.season_rank = 2
    left join season_z as prev2 on prev2.league = p.league and prev2.player_id = p.player_id and prev2.season_rank = 3

),

weights as (

    select
        *,
        case when has_cur then w_cur_raw else 0 end as w_cur0,
        case when has_prev then 0.55 * (1 - case when has_cur then w_cur_raw else 0 end) / 0.70 else 0 end as w_prev0,
        case when has_prev2 then 0.15 * (1 - case when has_cur then w_cur_raw else 0 end) / 0.70 else 0 end as w_prev20
    from blended

),

normalised as (

    select
        *,
        w_cur0 / nullif(w_cur0 + w_prev0 + w_prev20, 0) as w_cur,
        w_prev0 / nullif(w_cur0 + w_prev0 + w_prev20, 0) as w_prev,
        w_prev20 / nullif(w_cur0 + w_prev0 + w_prev20, 0) as w_prev2
    from weights

),

remaining as (

    select
        league,
        season,
        team_id,
        sum(case when game_date_est >= {{ as_of_date() }} and game_status <> 3 then 1 else 0 end) as games_remaining,
        count(*) as games_scheduled
    from (
        select league, season, home_team_id as team_id, game_date_est, game_status from {{ ref('schedule') }}
        union all
        select league, season, away_team_id as team_id, game_date_est, game_status from {{ ref('schedule') }}
    ) as sides
    group by league, season, team_id

),

current_stint as (

    select league, stats_player_id, player_sk, team_id, full_name, position
    from {{ ref('dim_player') }}
    where is_current

)

select
    {{ sk(['n.league', 'n.season', 'n.player_id']) }} as board_sk,
    n.league,
    n.season,
    n.player_id,
    cs.player_sk,
    cs.full_name,
    cs.position,
    cs.team_id,
    t.abbreviation as team_abbreviation,
    n.games_current,
    n.in_pool,
    n.w_cur,
    n.w_prev,
    n.w_prev2,
    {%- for z in zcols %}
    coalesce(n.w_cur * n.cur_{{ z }}, 0) + coalesce(n.w_prev * n.prev_{{ z }}, 0) + coalesce(n.w_prev2 * n.prev2_{{ z }}, 0) as {{ z }},
    {%- endfor %}
    1.0 as availability_multiplier,
    r.games_remaining,
    r.games_scheduled,
    (coalesce(n.w_cur * n.cur_z_total, 0) + coalesce(n.w_prev * n.prev_z_total, 0) + coalesce(n.w_prev2 * n.prev2_z_total, 0)) as value_total,
    (coalesce(n.w_cur * n.cur_z_total, 0) + coalesce(n.w_prev * n.prev_z_total, 0) + coalesce(n.w_prev2 * n.prev2_z_total, 0))
        * 1.0 * coalesce(r.games_remaining * 1.0 / nullif(r.games_scheduled, 0), 1.0) as value_rest_of_season,
    rank() over (partition by n.league order by (coalesce(n.w_cur * n.cur_z_total, 0) + coalesce(n.w_prev * n.prev_z_total, 0) + coalesce(n.w_prev2 * n.prev2_z_total, 0)) desc) as rank_total
from normalised as n
left join current_stint as cs on cs.league = n.league and cs.stats_player_id = n.player_id
left join {{ ref('teams') }} as t on t.league = n.league and t.season = n.season and t.team_id = cs.team_id
left join remaining as r on r.league = n.league and r.season = n.season and r.team_id = cs.team_id
