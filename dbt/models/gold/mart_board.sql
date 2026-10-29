{#
  The draft and in-season board: one row per player per league for the latest season.

  Blend: last season 0.55, the season before 0.15, current season 0.30 rising to 0.80 as games
  accumulate (linear to 20 games); missing seasons hand their weight to the others. The nine
  category z-scores are blended the same way so punt variants can be summed in the app. Only
  players with games in one of the three seasons are listed.

  Alongside the blend the row carries the current season's last-ten-games z-scores and
  per-game line, so the app can rank on recent form or raw production too.

  Rest of season counts regular-season games only, the games fantasy leagues score. While some
  remain, value_rest_of_season scales the blend by the team's remaining share of its regular
  season and by the availability multiplier, the share of those games the player is expected to
  play given the current injury report (out: the games before the expected return, or all of
  them without a date; doubtful 0.75 of a game, questionable 0.5, day-to-day 0.25). Once the
  regular season is over (playoffs or the off-season) season_complete is true and
  value_rest_of_season equals the blend. games_next_7 counts playoff games too.
#}

{% set zcols = ['z_points', 'z_rebounds_total', 'z_assists', 'z_steals', 'z_blocks', 'z_three_pointers_made', 'z_turnovers', 'z_field_goal_pct', 'z_free_throw_pct', 'z_total'] %}
{% set pgcols = ['minutes_pg', 'points_pg', 'rebounds_total_pg', 'assists_pg', 'steals_pg', 'blocks_pg', 'three_pointers_made_pg', 'turnovers_pg', 'field_goal_pct', 'free_throw_pct'] %}

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

    select league, player_id from season_z where season_rank <= 3 group by league, player_id

),

blended as (

    select
        p.league,
        cs.season,
        p.player_id,
        cur.games as games_current,
        cur.in_pool,
        0.30 + 0.50 * least(coalesce(cur.games, 0), 20) / 20.0 as w_cur_raw,
        cur.games is not null as has_cur,
        prev.games is not null as has_prev,
        prev2.games is not null as has_prev2,
        {%- for c in pgcols %}
        cur.{{ c }} as cur_{{ c }},
        {%- endfor %}
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

recent as (

    -- The current season's last ten games, for the "recent form" view.
    select z.*
    from {{ ref('mart_category_zscores') }} as z
    join current_season as cs on cs.league = z.league and cs.season = z.season
    where z.window_name = 'last_10'

),

schedule_sides as (

    select league, season, home_team_id as team_id, game_date_est, game_status, game_type, if_necessary from {{ ref('schedule') }}
    union all
    select league, season, away_team_id as team_id, game_date_est, game_status, game_type, if_necessary from {{ ref('schedule') }}

),

remaining as (

    select
        s.league,
        s.season,
        s.team_id,
        sum(case when s.game_type = 'regular' and s.game_date_est >= {{ as_of_date() }} and s.game_status <> 3 then 1 else 0 end) as games_remaining,
        sum(case when s.game_date_est >= {{ as_of_date() }} and s.game_date_est < {{ add_days(as_of_date(), 7) }}
                  and s.game_status <> 3 and not coalesce(s.if_necessary, false) then 1 else 0 end) as games_next_7,
        sum(case when s.game_type = 'regular' then 1 else 0 end) as games_scheduled
    from schedule_sides as s
    join current_season as cs on cs.league = s.league and cs.season = s.season
    where s.game_type in ('regular', 'playoffs')
    group by s.league, s.season, s.team_id

),

league_state as (

    select league, sum(games_remaining) = 0 as season_complete
    from remaining
    group by league

),

injury as (

    select league, stats_player_id, status, status_group, injury_type, expected_return, short_comment
    from {{ ref('fct_availability') }}
    where is_current and stats_player_id is not null
    qualify row_number() over (
        partition by league, stats_player_id
        order by case status_group when 'out' then 0 when 'doubtful' then 1 when 'questionable' then 2 when 'day_to_day' then 3 else 4 end
    ) = 1

),

games_before_return as (

    -- For a player ruled out with a return date: the team's remaining games before that date.
    select i.league, i.stats_player_id, count(*) as games_missed
    from injury as i
    join {{ ref('dim_player') }} as p
        on p.league = i.league and p.stats_player_id = i.stats_player_id and p.is_current
    join schedule_sides as s
        on s.league = i.league and s.team_id = p.team_id
    join current_season as cs on cs.league = s.league and cs.season = s.season
    where i.status_group = 'out' and i.expected_return is not null
        and s.game_type = 'regular' and s.game_status <> 3
        and s.game_date_est >= {{ as_of_date() }} and s.game_date_est < i.expected_return
    group by i.league, i.stats_player_id

),

current_stint as (

    select league, stats_player_id, player_sk, team_id, full_name, position
    from {{ ref('dim_player') }}
    where is_current

),

assembled as (

    select
        n.*,
        cs.player_sk,
        cs.full_name,
        cs.position,
        cs.team_id,
        t.abbreviation as team_abbreviation,
        cast(coalesce(r.games_remaining, 0) as integer) as games_remaining,
        cast(coalesce(r.games_next_7, 0) as integer) as games_next_7,
        cast(r.games_scheduled as integer) as games_scheduled,
        coalesce(ls.season_complete, true) as season_complete,
        i.status as injury_status,
        i.status_group as injury_group,
        i.injury_type,
        i.expected_return,
        i.short_comment as injury_note,
        case
            when coalesce(ls.season_complete, true) or coalesce(r.games_remaining, 0) = 0 or i.status_group is null then 1.0
            else greatest(0.0, (r.games_remaining - case i.status_group
                    when 'out' then coalesce(gbr.games_missed, case when i.expected_return is null then r.games_remaining else 0 end)
                    when 'doubtful' then 0.75
                    when 'questionable' then 0.5
                    when 'day_to_day' then 0.25
                    else 0 end) * 1.0 / r.games_remaining)
        end as availability_multiplier,
        {%- for z in zcols %}
        coalesce(n.w_cur * n.cur_{{ z }}, 0) + coalesce(n.w_prev * n.prev_{{ z }}, 0) + coalesce(n.w_prev2 * n.prev2_{{ z }}, 0) as blend_{{ z }},
        rc.{{ z }} as recent_{{ z }}{{ "," if not loop.last }}
        {%- endfor %}
    from normalised as n
    left join current_stint as cs on cs.league = n.league and cs.stats_player_id = n.player_id
    left join {{ ref('teams') }} as t on t.league = n.league and t.season = n.season and t.team_id = cs.team_id
    left join remaining as r on r.league = n.league and r.season = n.season and r.team_id = cs.team_id
    left join league_state as ls on ls.league = n.league
    left join injury as i on i.league = n.league and i.stats_player_id = n.player_id
    left join games_before_return as gbr on gbr.league = n.league and gbr.stats_player_id = n.player_id
    left join recent as rc on rc.league = n.league and rc.player_id = n.player_id

)

select
    {{ sk(['league', 'season', 'player_id']) }} as board_sk,
    league,
    season,
    player_id,
    player_sk,
    full_name,
    position,
    team_id,
    team_abbreviation,
    games_current,
    in_pool,
    w_cur,
    w_prev,
    w_prev2,
    {%- for z in zcols %}
    blend_{{ z }} as {{ z }},
    {%- endfor %}
    {%- for z in zcols %}
    recent_{{ z }},
    {%- endfor %}
    {%- for c in pgcols %}
    cur_{{ c }} as {{ c }},
    {%- endfor %}
    injury_status,
    injury_group,
    injury_type,
    expected_return,
    injury_note,
    availability_multiplier,
    games_remaining,
    games_next_7,
    games_scheduled,
    season_complete,
    blend_z_total as value_total,
    case
        when season_complete then blend_z_total
        else blend_z_total * availability_multiplier * coalesce(games_remaining * 1.0 / nullif(games_scheduled, 0), 1.0)
    end as value_rest_of_season,
    rank() over (partition by league order by blend_z_total desc) as rank_total
from assembled
