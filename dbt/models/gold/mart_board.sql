{#
  The draft and in-season board: one row per rostered player per league.

  Value is scored once, on each player's projected per-game line (mart_player_projection:
  per-minute production times projected minutes), in two passes. Pass one standardises the nine categories over the pool_size players with
  the most projected minutes; pass two repeats it over the pool_size players pass one values
  most, so the means and spreads describe the players a fantasy league actually rosters.
  Counting categories are z-scores of the projected per-game numbers (turnovers negative);
  percentages are volume-weighted, (player pct - pool pct) x attempts per game, standardised
  over the pool.

  Every category then has replacement level subtracted: the average category score of the
  next `teams` players after the pool. Zero is a freely available player, so the nine values
  sum to value per game above replacement (value_per_game) and a punt build is the sum
  without the punted columns. value_total counts games: value per game times the projected
  share of team games the player plays (games_share), since a missed game is filled by a
  replacement-level player; a value below replacement is left as it is.

  Alongside the value the row carries the current season's z-scores over the whole season and
  the last twenty and ten games, the per-game line, the projected line itself, and the
  player's age and rookie status from the roster, so the app can rank on recent form or raw
  production too and filter the way a fantasy manager does.

  Rest of season counts regular-season games only, the games fantasy leagues score. While some
  remain, ros_factor is the team's remaining share of its regular season times the
  availability multiplier, the share of those games the player is expected to play given the
  current injury report (out: the games before the expected return, or all of them without a
  date; doubtful 0.75 of a game, questionable 0.5, day-to-day 0.25). value_rest_of_season
  scales value above replacement by it; a value below replacement is left as it is, since a
  missing game from a player not worth rostering costs nothing. Once the regular season is
  over (playoffs or the off-season) season_complete is true and ros_factor is 1.
  games_next_7 counts playoff games too.
#}

{% set cats = ['points', 'rebounds_total', 'assists', 'steals', 'blocks', 'three_pointers_made', 'turnovers'] %}
{% set zcols = ['z_points', 'z_rebounds_total', 'z_assists', 'z_steals', 'z_blocks', 'z_three_pointers_made', 'z_turnovers', 'z_field_goal_pct', 'z_free_throw_pct'] %}
{% set pgcols = ['minutes_pg', 'points_pg', 'rebounds_total_pg', 'assists_pg', 'steals_pg', 'blocks_pg', 'three_pointers_made_pg', 'turnovers_pg', 'field_goal_pct', 'free_throw_pct'] %}
{% set projcols = ['proj_minutes_pg', 'proj_points_pg', 'proj_rebounds_total_pg', 'proj_assists_pg', 'proj_steals_pg', 'proj_blocks_pg', 'proj_three_pointers_made_pg', 'proj_turnovers_pg', 'proj_fgm_pg', 'proj_fga_pg', 'proj_ftm_pg', 'proj_fta_pg', 'proj_field_goal_pct', 'proj_free_throw_pct'] %}

with base as (

    select
        p.*,
        count(*) over (partition by p.league) as players,
        -- the pool, never so large that no one is left to set replacement level
        least({{ fantasy_setting('pool_size', 'p.league') }}, greatest(count(*) over (partition by p.league) - {{ fantasy_setting('teams', 'p.league') }}, 1)) as pool,
        {{ fantasy_setting('teams', 'p.league') }} as teams,
        row_number() over (partition by p.league order by p.proj_minutes_pg desc, p.player_id) as pool_rank_0
    from {{ ref('mart_player_projection') }} as p

),

{% for n in [1, 2] %}
moments_{{ n }} as (

    select
        *,
        {%- for c in cats %}
        avg(case when pool_rank_{{ n - 1 }} <= pool then proj_{{ c }}_pg end) over (partition by league) as mean_{{ c }}_{{ n }},
        stddev_samp(case when pool_rank_{{ n - 1 }} <= pool then proj_{{ c }}_pg end) over (partition by league) as sd_{{ c }}_{{ n }},
        {%- endfor %}
        sum(case when pool_rank_{{ n - 1 }} <= pool then proj_fgm_pg end) over (partition by league)
            / nullif(sum(case when pool_rank_{{ n - 1 }} <= pool then proj_fga_pg end) over (partition by league), 0) as pool_fg_{{ n }},
        sum(case when pool_rank_{{ n - 1 }} <= pool then proj_ftm_pg end) over (partition by league)
            / nullif(sum(case when pool_rank_{{ n - 1 }} <= pool then proj_fta_pg end) over (partition by league), 0) as pool_ft_{{ n }}
    from {{ 'base' if n == 1 else 'ranked_1' }}

),

impacts_{{ n }} as (

    select
        *,
        coalesce((proj_field_goal_pct - pool_fg_{{ n }}) * proj_fga_pg, 0) as fg_impact_{{ n }},
        coalesce((proj_free_throw_pct - pool_ft_{{ n }}) * proj_fta_pg, 0) as ft_impact_{{ n }}
    from moments_{{ n }}

),

scored_{{ n }} as (

    select
        *,
        {%- for c in cats %}
        coalesce({% if c == 'turnovers' %}-{% endif %}(proj_{{ c }}_pg - mean_{{ c }}_{{ n }}) / nullif(sd_{{ c }}_{{ n }}, 0), 0) as z_{{ c }}_{{ n }},
        {%- endfor %}
        coalesce(fg_impact_{{ n }} / nullif(stddev_samp(case when pool_rank_{{ n - 1 }} <= pool then fg_impact_{{ n }} end) over (partition by league), 0), 0) as z_field_goal_pct_{{ n }},
        coalesce(ft_impact_{{ n }} / nullif(stddev_samp(case when pool_rank_{{ n - 1 }} <= pool then ft_impact_{{ n }} end) over (partition by league), 0), 0) as z_free_throw_pct_{{ n }}
    from impacts_{{ n }}

),

ranked_{{ n }} as (

    select
        *,
        row_number() over (
            partition by league
            order by {% for z in zcols %}{{ z }}_{{ n }}{{ " + " if not loop.last }}{% endfor %} desc, player_id
        ) as pool_rank_{{ n }}
    from scored_{{ n }}

),
{% endfor %}

replacement as (

    select
        league,
        {%- for z in zcols %}
        avg({{ z }}_2) as repl_{{ z }}{{ "," if not loop.last }}
        {%- endfor %}
    from ranked_2
    where pool_rank_2 > pool and pool_rank_2 <= pool + teams
    group by league

),

valued as (

    select
        r.*,
        r.pool_rank_2 <= r.pool as in_pool,
        {%- for z in zcols %}
        r.{{ z }}_2 - coalesce(rp.repl_{{ z }}, 0) as {{ z }}{{ "," if not loop.last }}
        {%- endfor %}
    from ranked_2 as r
    left join replacement as rp on rp.league = r.league

),

season_lines as (

    select z.*
    from {{ ref('mart_category_zscores') }} as z
    join (select distinct league, season from base) as cs on cs.league = z.league and cs.season = z.season

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
    join (select distinct league, season from base) as cs on cs.league = s.league and cs.season = s.season
    where s.game_type in ('regular', 'playoffs')
    group by s.league, s.season, s.team_id

),

league_state as (

    select league, sum(games_remaining) = 0 as season_complete
    from remaining
    group by league

),

injury as (

    -- The status shown: the official report for the next game, else ESPN (fct_player_status).
    -- The rest-of-season multiplier reads ESPN's listing (espn_status_group): the official
    -- report speaks only to the next game.
    select league, stats_player_id, status, status_group, injury_type, expected_return, short_comment,
        long_comment, status_since, espn_status_group, status_source, official_game_date, official_report_at
    from {{ ref('fct_player_status') }}

),

games_before_return as (

    -- For a player ruled out with a return date: the team's remaining games before that date.
    select i.league, i.stats_player_id, count(*) as games_missed
    from injury as i
    join base as b on b.league = i.league and b.player_id = i.stats_player_id
    join schedule_sides as s
        on s.league = b.league and s.season = b.season and s.team_id = b.team_id
    where i.espn_status_group = 'out' and i.expected_return is not null
        and s.game_type = 'regular' and s.game_status <> 3
        and s.game_date_est >= {{ as_of_date() }} and s.game_date_est < i.expected_return
    group by i.league, i.stats_player_id

),

team_names as (

    -- a team's latest abbreviation, for the previous team of a player who moved
    select league, team_id, abbreviation
    from {{ ref('teams') }}
    qualify row_number() over (partition by league, team_id order by season desc) = 1

),

names as (

    select league, stats_player_id, player_sk, full_name, position,
        {{ stats_birth_date('birth_date') }} as birth_date
    from {{ ref('dim_player') }}
    where is_current

),

assembled as (

    select
        v.*,
        nm.player_sk,
        nm.full_name,
        nm.position,
        coalesce(cast(floor({{ days_between('nm.birth_date', as_of_date()) }} / 365.25) as integer), v.age) as age_years,
        coalesce(t.abbreviation, t_prev.abbreviation) as team_abbreviation,
        pt.abbreviation as prev_team_abbreviation,
        cast(coalesce(r.games_remaining, 0) as integer) as games_remaining,
        cast(coalesce(r.games_next_7, 0) as integer) as games_next_7,
        cast(r.games_scheduled as integer) as games_scheduled,
        coalesce(ls.season_complete, true) as season_complete,
        i.status as injury_status,
        i.status_group as injury_group,
        i.injury_type,
        i.expected_return,
        i.short_comment as injury_note,
        i.long_comment as injury_news,
        i.status_since as injury_since,
        i.status_source as injury_source,
        i.official_game_date,
        i.official_report_at,
        lu.lineup_role,
        lu.is_confirmed as lineup_confirmed,
        case
            when coalesce(ls.season_complete, true) or coalesce(r.games_remaining, 0) = 0 or i.espn_status_group is null then 1.0
            else greatest(0.0, (r.games_remaining - case i.espn_status_group
                    when 'out' then coalesce(gbr.games_missed, case when i.expected_return is null then r.games_remaining else 0 end)
                    when 'doubtful' then 0.75
                    when 'questionable' then 0.5
                    when 'day_to_day' then 0.25
                    else 0 end) * 1.0 / r.games_remaining)
        end as availability_multiplier,
        {%- for c in pgcols %}
        sl.{{ c }} as cur_{{ c }},
        {%- endfor %}
        {%- for z in zcols + ['z_total'] %}
        sl.{{ z }} as season_{{ z }},
        l20.{{ z }} as last20_{{ z }},
        rc.{{ z }} as recent_{{ z }}{{ "," if not loop.last }}
        {%- endfor %}
    from valued as v
    left join names as nm on nm.league = v.league and nm.stats_player_id = v.player_id
    left join {{ ref('teams') }} as t on t.league = v.league and t.season = v.roster_season and t.team_id = v.team_id
    left join {{ ref('teams') }} as t_prev on t_prev.league = v.league and t_prev.season = v.season and t_prev.team_id = v.team_id
    left join remaining as r on r.league = v.league and r.season = v.season and r.team_id = v.team_id
    left join league_state as ls on ls.league = v.league
    left join team_names as pt on pt.league = v.league and pt.team_id = v.prev_team_id
    left join injury as i on i.league = v.league and i.stats_player_id = v.player_id
    left join games_before_return as gbr on gbr.league = v.league and gbr.stats_player_id = v.player_id
    left join {{ ref('fct_starting_lineup') }} as lu on lu.league = v.league and lu.player_id = v.player_id
    left join season_lines as sl on sl.league = v.league and sl.player_id = v.player_id and sl.window_name = 'season'
    left join season_lines as rc on rc.league = v.league and rc.player_id = v.player_id and rc.window_name = 'last_10'
    left join season_lines as l20 on l20.league = v.league and l20.player_id = v.player_id and l20.window_name = 'last_20'

),

totals as (

    select
        *,
        {% for z in zcols %}{{ z }}{{ " + " if not loop.last }}{% endfor %} as z_total,
        case
            when {% for z in zcols %}{{ z }}{{ " + " if not loop.last }}{% endfor %} > 0
                then ({% for z in zcols %}{{ z }}{{ " + " if not loop.last }}{% endfor %}) * games_share
            else {% for z in zcols %}{{ z }}{{ " + " if not loop.last }}{% endfor %}
        end as season_value,
        case
            when season_complete then 1.0
            else availability_multiplier * coalesce(games_remaining * 1.0 / nullif(games_scheduled, 0), 1.0)
        end as ros_factor
    from assembled

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
    games_prev,
    games_prev2,
    minutes_current,
    minutes_prev,
    minutes_prev2,
    games_share,
    in_pool,
    w_cur,
    w_prev,
    w_prev2,
    w_prior,
    sample_weight,
    {%- for z in zcols + ['z_total'] %}
    {{ z }},
    {%- endfor %}
    {%- for z in zcols + ['z_total'] %}
    recent_{{ z }},
    season_{{ z }},
    last20_{{ z }},
    {%- endfor %}
    age_years as age,
    is_rookie,
    is_new_team,
    prev_team_abbreviation,
    {%- for c in pgcols %}
    cur_{{ c }} as {{ c }},
    {%- endfor %}
    {%- for c in projcols %}
    {{ c }},
    {%- endfor %}
    injury_status,
    injury_group,
    injury_type,
    expected_return,
    injury_note,
    injury_news,
    injury_since,
    injury_source,
    official_game_date,
    official_report_at,
    lineup_role,
    lineup_confirmed,
    availability_multiplier,
    games_remaining,
    games_next_7,
    games_scheduled,
    season_complete,
    ros_factor,
    z_total as value_per_game,
    season_value as value_total,
    case when season_value > 0 then season_value * ros_factor else season_value end as value_rest_of_season,
    rank() over (partition by league order by season_value desc, player_id) as rank_total
from totals
