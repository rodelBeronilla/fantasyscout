{#
  The draft and in-season board: one row per rostered player per league.

  Value is scored once, on each player's projected per-game line (mart_player_projection:
  per-minute production times projected minutes), on the season's value scale (int_value_scale,
  ADR 0019): the pool_size players a league rosters, chosen in two passes over the projected
  lines, set each category's mean and spread. Counting categories are z-scores of the projected
  per-game numbers (turnovers negative); percentages are makes above the pool's percentage on
  the attempts, standardised over the pool. The season, last twenty and last ten columns are on
  the same scale (mart_category_zscores), so they compare directly with the value.

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
  current status. The games a listed player is expected to miss are calibrated on history
  (fct_official_listing): the average, over past injury listings with the same status, of the
  games the player then missed, capped at the games the team has left, with the same reason (an
  official Out for rest is averaged over rest listings, not injuries). The status is the
  official report's for the next game, else ESPN's listing in the report's words (day-to-day
  reads as questionable); the history is fct_status_calibration's histogram, the league's own
  listings once it has 300 for the status and reason, else the NBA's. ESPN's expected return
  date, when given for a player ruled out, counts the
  games before it instead, and a note that the player is out for the season counts them all.
  Without any history the old charges apply (out: every game; doubtful 0.75 of a game,
  questionable 0.5, day-to-day 0.25). value_rest_of_season
  scales value above replacement by it; a value below replacement is left as it is, since a
  missing game from a player not worth rostering costs nothing. Once the regular season is
  over (playoffs or the off-season) season_complete is true and ros_factor is 1.
  A regular (fantasy_rest_risk.min_minutes projected) on a team with nothing left to play for
  (fct_team_stakes.rest_risk) is expected to sit out fantasy_rest_risk.extra_sit_out more of the
  games left, measured point in time in notebook 03 (#494): the multiplier keeps the rest.
  games_next_7 counts playoff games too.

  The market prior (var market_prior, #832, off by default): while a player has few games in the
  season being played, value per game is blended toward the board's own value of his rank in the
  market's draft order (int_market_prior), at market_prior.weight falling linearly to nothing by
  market_prior.fade_games games. The nine category columns stay the projection's; z_total carries
  the blend.
#}

{% set zcols = ['z_points', 'z_rebounds_total', 'z_assists', 'z_steals', 'z_blocks', 'z_three_pointers_made', 'z_turnovers', 'z_field_goal_pct', 'z_free_throw_pct'] %}
{% set pgcols = ['minutes_pg', 'points_pg', 'rebounds_total_pg', 'assists_pg', 'steals_pg', 'blocks_pg', 'three_pointers_made_pg', 'turnovers_pg', 'field_goal_pct', 'free_throw_pct'] %}
{% set projcols = ['proj_minutes_pg', 'proj_points_pg', 'proj_rebounds_total_pg', 'proj_assists_pg', 'proj_steals_pg', 'proj_blocks_pg', 'proj_three_pointers_made_pg', 'proj_turnovers_pg', 'proj_fgm_pg', 'proj_fga_pg', 'proj_ftm_pg', 'proj_fta_pg', 'proj_field_goal_pct', 'proj_free_throw_pct'] %}

with base as (

    select p.*
    from {{ ref('mart_player_projection') }} as p

),

scored as (

    -- the projected line on the season's value scale: value per game above replacement (ADR 0019)
    select
        b.*,
        s.pool,
        {{ scale_z_columns(pg_stat('b', 'proj_'), 's') }}
    from base as b
    join {{ ref('int_value_scale') }} as s on s.league = b.league and s.season = b.season

),

priced as (

    -- each player's own value and his place on the board's value curve, which prices a draft
    -- position on the board's scale as Trade does in the web (marketValues)
    select
        *,
        {% for z in zcols %}{{ z }}{{ " + " if not loop.last }}{% endfor %} as own_value,
        row_number() over (
            partition by league
            order by {% for z in zcols %}{{ z }}{{ " + " if not loop.last }}{% endfor %} desc, player_id
        ) as value_rank
    from scored

),

{#- The market prior (#832): while a player has few games in the season being played, his value
    is blended toward the board's value of his rank in the market's draft order, at a weight that
    falls to nothing by fade_games games. Off (weight 0) unless market_prior.enabled. #}
{%- set prior = var('market_prior') %}
{%- set prior_weight = prior['weight'] if prior['enabled'] else 0 %}
weighted_prior as (

    select
        p.*,
        mp.adp_rank as preseason_adp_rank,
        cast(coalesce(mp.games, 0) as integer) as market_prior_games,
        curve.own_value as market_prior_value,
        case
            when curve.own_value is null then 0.0
            else {{ prior_weight }} * greatest(0.0, 1.0 - coalesce(mp.games, 0) * 1.0 / {{ prior['fade_games'] }})
        end as market_prior_weight
    from priced as p
    left join {{ ref('int_market_prior') }} as mp on mp.league = p.league and mp.player_id = p.player_id
    left join priced as curve on curve.league = p.league and curve.value_rank = mp.adp_rank

),

valued as (

    select
        *,
        row_number() over (partition by league order by value_blend desc, player_id) <= pool as in_pool
    from (
        select
            *,
            own_value + market_prior_weight * (coalesce(market_prior_value, own_value) - own_value) as value_blend
        from weighted_prior
    ) as blended

),

season_lines as (

    select z.*
    from {{ ref('mart_category_zscores') }} as z
    join (select distinct league, season from base) as cs on cs.league = z.league and cs.season = z.season

),

schedule_sides as (

    select league, season, team_id, game_date_est, game_status, game_type, if_necessary
    from {{ ref('schedule_team_games') }}

),

remaining_scheduled as (

    select
        s.league,
        s.season,
        s.team_id,
        sum(case when s.game_type = 'regular' and s.game_date_est >= {{ as_of_date() }} and not {{ is_final('s.game_status', 's.game_date_est') }} then 1 else 0 end) as games_remaining,
        sum(case when s.game_date_est >= {{ as_of_date() }} and s.game_date_est < {{ add_days(as_of_date(), 7) }}
                  and not {{ is_final('s.game_status', 's.game_date_est') }} and not coalesce(s.if_necessary, false) then 1 else 0 end) as games_next_7,
        -- the fantasy week runs Monday to Sunday
        sum(case when s.game_date_est >= {{ as_of_date() }} and s.game_date_est < {{ add_days(week_start(as_of_date()), 7) }}
                  and not {{ is_final('s.game_status', 's.game_date_est') }} and not coalesce(s.if_necessary, false) then 1 else 0 end) as games_this_week,
        sum(case when s.game_type = 'regular' then 1 else 0 end) as games_scheduled,
        sum(case when s.game_type = 'regular' and {{ is_final('s.game_status', 's.game_date_est') }} then 1 else 0 end) as games_final
    from schedule_sides as s
    join (select distinct league, season from base) as cs on cs.league = s.league and cs.season = s.season
    -- games remaining count the regular season; the next seven days and the week count every game
    -- a team plays, the play-in and the playoffs included (#391)
    where s.game_type in ('regular', 'play_in', 'playoffs')
    group by s.league, s.season, s.team_id

),

{#- Where a league's season length is fixed (var regular_season_games), remaining is that length
    minus the games played and the season's length is the denominator: the NBA's schedule lists two
    games per team as placeholders until December, so counting it says 80 (#386). #}
{%- set season_games = var('regular_season_games', {}) %}
remaining as (

    select
        league,
        season,
        team_id,
        {%- if season_games %}
        case league
            {%- for lg, n in season_games.items() %}
            when '{{ lg }}' then greatest({{ n }} - games_final, 0)
            {%- endfor %}
            else games_remaining
        end as games_remaining,
        {%- else %}
        games_remaining,
        {%- endif %}
        games_next_7,
        games_this_week,
        {%- if season_games %}
        case league
            {%- for lg, n in season_games.items() %}
            when '{{ lg }}' then {{ n }}
            {%- endfor %}
            else games_scheduled
        end as games_scheduled
        {%- else %}
        games_scheduled
        {%- endif %}
    from remaining_scheduled

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
        long_comment, status_since, espn_status_group, status_source, official_status, official_reason_group,
        official_game_date, official_report_at
    from {{ ref('fct_player_status') }}

),

latest_news as (

    -- The newest flagged headline about the player in the last three days (int_player_news_latest).
    select league, stats_player_id, news_flag, news_headline, news_date
    from {{ ref('int_player_news_latest') }}

),

games_before_return as (

    -- For a player ruled out with a return date: the team's remaining games before that date.
    select i.league, i.stats_player_id, count(*) as games_missed
    from injury as i
    join base as b on b.league = i.league and b.player_id = i.stats_player_id
    join schedule_sides as s
        on s.league = b.league and s.season = b.season and s.team_id = b.team_id
    where i.espn_status_group = 'out' and i.expected_return is not null
        and s.game_type = 'regular' and not {{ is_final('s.game_status', 's.game_date_est') }}
        and s.game_date_est >= {{ as_of_date() }} and s.game_date_est < i.expected_return
    group by i.league, i.stats_player_id

),

-- The status the calibration reads: the official report's for the next game with its reason
-- (injury, rest, g_league, personal...), else ESPN's listing in the report's words (day-to-day
-- reads as questionable), which is always an injury. An official Available reads as Probable,
-- the mildest status listed, rather than falling through to ESPN's listing (#388).
calibration_status as (

    select
        league,
        stats_player_id,
        case
            when official_status in ('Out', 'Doubtful', 'Questionable', 'Probable', 'Available')
                then coalesce(official_reason_group, 'injury')
            else 'injury'
        end as reason_group,
        coalesce(
            case
                when official_status in ('Out', 'Doubtful', 'Questionable', 'Probable') then official_status
                when official_status = 'Available' then 'Probable'
            end,
            case espn_status_group
                when 'out' then 'Out'
                when 'doubtful' then 'Doubtful'
                when 'questionable' then 'Questionable'
                when 'day_to_day' then 'Questionable'
            end
        ) as status
    from injury

),

expected_missed as (

    -- The listings-weighted mean, over the histogram rows for the player's league, status and
    -- reason (fct_status_calibration), of the games then missed, each capped at the games the
    -- team has left: a night of rest is not an injury.
    select
        b.league,
        b.player_id,
        sum(least(c.games_missed, r.games_remaining) * c.listings) * 1.0 / sum(c.listings) as games_missed,
        sum(c.listings) as listings
    from base as b
    join remaining as r on r.league = b.league and r.season = b.season and r.team_id = b.team_id
    join calibration_status as cst on cst.league = b.league and cst.stats_player_id = b.player_id
    join {{ ref('fct_status_calibration') }} as c
        on c.league = b.league and c.status = cst.status and c.reason_group = cst.reason_group
    where r.games_remaining > 0
    group by b.league, b.player_id

),

team_names as (

    -- a team's latest abbreviation, for the previous team of a player who moved
    select league, team_id, abbreviation from {{ ref('team_current') }}

),

names as (

    select league, stats_player_id, player_sk, full_name, position, birth_date
    from {{ ref('dim_player') }}
    where is_current

),

assembled as (

    select
        v.*,
        -- a listed player's share of games leaves out the absence he is still on, which
        -- availability_multiplier counts (#690); everyone else's is the projection's
        case when i.espn_status_group is not null then coalesce(v.games_share_healthy, v.games_share) else v.games_share end
            as games_share_now,
        nm.player_sk,
        nm.full_name,
        nm.position,
        coalesce(cast(floor({{ days_between('nm.birth_date', as_of_date()) }} / 365.25) as integer), v.age) as age_years,
        coalesce(t.abbreviation, t_prev.abbreviation) as team_abbreviation,
        pt.abbreviation as prev_team_abbreviation,
        cast(coalesce(r.games_remaining, 0) as integer) as games_remaining,
        cast(coalesce(r.games_next_7, 0) as integer) as games_next_7,
        cast(coalesce(r.games_this_week, 0) as integer) as games_this_week,
        cast(r.games_scheduled as integer) as games_scheduled,
        coalesce(ls.season_complete, true) as season_complete,
        -- a status with a group, as Streamers shows it: an official Available clears the listing
        case when i.status_group is not null then i.status end as injury_status,
        i.status_group as injury_group,
        i.injury_type,
        i.expected_return,
        i.short_comment as injury_note,
        i.long_comment as injury_news,
        i.status_since as injury_since,
        i.status_source as injury_source,
        i.official_game_date,
        i.official_report_at,
        ln.news_flag,
        ln.news_headline,
        ln.news_date,
        lu.lineup_role,
        lu.is_confirmed as lineup_confirmed,
        lu.game_date as lineup_date,
        mk.market_rank,
        mk.ownership_bucket,
        mk.ownership_trend,
        ts.stakes as team_stakes,
        coalesce(ts.rest_risk, false) as rest_risk,
        case
            when coalesce(ls.season_complete, true) or coalesce(r.games_remaining, 0) = 0 then 1.0
            -- ruled out with a return date: the games before it
            when i.espn_status_group = 'out' and i.expected_return is not null
                then greatest(0.0, (r.games_remaining - coalesce(gbr.games_missed, 0)) * 1.0 / r.games_remaining)
            -- ruled out for the season
            when i.espn_status_group = 'out'
                and {{ matches("lower(coalesce(i.short_comment, '') || ' ' || coalesce(i.long_comment, ''))", 'out for the (rest of the )?season|season-ending|remainder of the season') }}
                then 0.0
            -- calibrated on past listings with the same status
            when em.games_missed is not null
                then greatest(0.0, (r.games_remaining - em.games_missed) * 1.0 / r.games_remaining)
            when i.espn_status_group is null then 1.0
            -- no history to calibrate on: the old charges
            else greatest(0.0, (r.games_remaining - case i.espn_status_group
                    when 'out' then r.games_remaining
                    when 'doubtful' then 0.75
                    when 'questionable' then 0.5
                    when 'day_to_day' then 0.25
                    else 0 end) * 1.0 / r.games_remaining)
        end
        -- a regular on a team with nothing to play for sits out more of the games left (#494)
        * case
            when coalesce(ts.rest_risk, false) and not coalesce(ls.season_complete, true)
                and v.proj_minutes_pg >= case v.league
                    {%- for lg, s in var('fantasy_rest_risk').items() %} when '{{ lg }}' then {{ s['min_minutes'] }}{% endfor %} else 999 end
                then 1.0 - case v.league
                    {%- for lg, s in var('fantasy_rest_risk').items() %} when '{{ lg }}' then {{ s['extra_sit_out'] }}{% endfor %} else 0 end
            else 1.0
        end as availability_multiplier,
        em.games_missed as expected_games_missed,
        cn.game_floor,
        cn.game_ceiling,
        cn.game_value_sd,
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
    left join expected_missed as em on em.league = v.league and em.player_id = v.player_id
    left join latest_news as ln on ln.league = v.league and ln.stats_player_id = v.player_id
    left join {{ ref('fct_starting_lineup') }} as lu on lu.league = v.league and lu.player_id = v.player_id
    left join {{ ref('fct_market_value') }} as mk on mk.league = v.league and mk.stats_player_id = v.player_id
    left join {{ ref('fct_team_stakes') }} as ts on ts.league = v.league and ts.team_id = v.team_id
    left join season_lines as sl on sl.league = v.league and sl.player_id = v.player_id and sl.window_name = 'season'
    left join season_lines as rc on rc.league = v.league and rc.player_id = v.player_id and rc.window_name = 'last_10'
    left join season_lines as l20 on l20.league = v.league and l20.player_id = v.player_id and l20.window_name = 'last_20'
    left join {{ ref('mart_player_consistency') }} as cn on cn.league = v.league and cn.season = v.season and cn.player_id = v.player_id

),

totals as (

    select
        *,
        -- the nine categories' sum, blended toward the market while the prior is on (#832)
        value_blend as z_total,
        case
            when value_blend > 0 then value_blend * games_share_now
            else value_blend
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
    games_share_now as games_share,
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
    news_flag,
    news_headline,
    news_date,
    lineup_role,
    lineup_confirmed,
    lineup_date,
    market_rank,
    preseason_adp_rank,
    market_prior_value,
    market_prior_games,
    market_prior_weight,
    game_floor,
    game_ceiling,
    game_value_sd,
    ownership_bucket,
    ownership_trend,
    team_stakes,
    rest_risk,
    availability_multiplier,
    expected_games_missed,
    games_remaining,
    games_next_7,
    games_this_week,
    games_scheduled,
    season_complete,
    ros_factor,
    z_total as value_per_game,
    season_value as value_total,
    case when season_value > 0 then season_value * ros_factor else season_value end as value_rest_of_season,
    rank() over (partition by league order by season_value desc, player_id) as rank_total,
    -- Positive: the market drafts the player later than the board ranks the player (a value pick).
    market_rank - rank() over (partition by league order by season_value desc, player_id) as market_gap
from totals
