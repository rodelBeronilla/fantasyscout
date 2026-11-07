{#
  Absence spells from the official injury reports, censoring-aware (#768, epic #751): one row per
  run of regular-season games a listed player missed, from the first listed game missed to the
  next game the player played. It is the input the recovery-timeline survival model (#770) reads.

  - A spell is the listed games a player missed that share the same next played game: listings
    for consecutive missed games, even with a game between them the report left the player off.
  - games_missed counts the team's regular-season games from the first through the last before the
    return (fct_official_listing's count for the spell's first listing); days_out the days from the
    first game missed to the return.
  - A spell with a return is observed. One without is censored, not short: `ongoing` while the
    team still has regular-season games to play (the spell was running at the cut, and a
    point-in-time build cuts it as of its date), `season_end` when the season ended first. Either
    way games_missed and days_out are what was seen, a lower bound on the spell, and a survival
    model must treat them so; counting them as finished spells understates long injuries.
  - What it was: the first listing's status, the most serious status listed during the spell, and
    the injury detail of the first listing split into the side (left, right), the body part and
    the kind (soreness, sprain, strain, fracture, surgery, ...; null when the report says only
    "injury" or repeats the body part). The league's own reason group says whether it was an
    injury, rest, personal, a suspension or another absence; a concussion protocol listing is an
    injury to the head.
#}

with listings as (

    select *
    from {{ ref('fct_official_listing') }}
    where not played

),

next_played as (

    -- each missed listing's next played regular-season game that season (null: none yet)
    select
        l.league,
        l.game_id,
        l.player_id,
        min(g.game_date) as return_date
    from listings as l
    left join {{ ref('fct_player_game') }} as g
        on g.league = l.league and g.season = l.season and g.player_id = l.player_id
        and g.played and {{ is_regular_season('g.game_id') }} and g.game_date > l.game_date
    group by l.league, l.game_id, l.player_id

),

keyed as (

    select
        l.*,
        np.return_date,
        case lower(l.status)
            when 'out' then 4
            when 'doubtful' then 3
            when 'questionable' then 2
            when 'probable' then 1
            else 0
        end as status_rank
    from listings as l
    join next_played as np on np.league = l.league and np.game_id = l.game_id and np.player_id = l.player_id

),

spells as (

    select
        league,
        season,
        player_id,
        return_date,
        min(game_date) as start_date,
        max(game_date) as last_listed_date,
        cast(count(*) as integer) as listings,
        max(status_rank) as worst_rank,
        min_by(status, game_date) as first_status,
        min_by(reason_group, game_date) as reason_group,
        min_by(injury_detail, game_date) as injury_detail,
        min_by(team_id, game_date) as team_id,
        min_by(game_id, game_date) as first_game_id,
        min_by(games_missed, game_date) as games_missed
    from keyed
    group by league, season, player_id, return_date

),

team_left as (

    -- regular-season games each team still has to play
    select
        league,
        season,
        team_id,
        sum(case when game_type = 'regular' and not {{ is_final('game_status', 'game_date_est') }} then 1 else 0 end) as games_left,
        max(case when game_type = 'regular' and {{ is_final('game_status', 'game_date_est') }} then game_date_est end) as last_final_date
    from {{ ref('schedule_team_games') }}
    group by league, season, team_id

),

parsed as (

    select
        s.*,
        tl.games_left,
        tl.last_final_date,
        lower(trim(case when s.injury_detail like '%;%' then substr(s.injury_detail, 1, instr(s.injury_detail, ';') - 1) else s.injury_detail end)) as site,
        lower(trim(case when s.injury_detail like '%;%' then substr(s.injury_detail, instr(s.injury_detail, ';') + 1) end)) as kind_raw
    from spells as s
    left join team_left as tl on tl.league = s.league and tl.season = s.season and tl.team_id = s.team_id

)

select
    {{ sk(['league', 'player_id', 'first_game_id']) }} as injury_spell_sk,
    league,
    season,
    player_id,
    team_id,
    first_game_id,
    start_date,
    return_date,
    return_date is not null as returned,
    case
        when return_date is not null then null
        when coalesce(games_left, 0) > 0 then 'ongoing'
        else 'season_end'
    end as censored,
    games_missed,
    cast({{ days_between('start_date', 'coalesce(return_date, greatest(last_listed_date, coalesce(last_final_date, last_listed_date)))') }} as integer) as days_out,
    listings,
    first_status,
    case worst_rank when 4 then 'Out' when 3 then 'Doubtful' when 2 then 'Questionable' when 1 then 'Probable' end as worst_status,
    case when lower(injury_detail) like 'concussion%' then 'injury' else reason_group end as reason_group,
    injury_detail,
    case
        when site like 'left %' then 'left'
        when site like 'right %' then 'right'
        when site like 'bilateral %' then 'both'
    end as side,
    case
        when lower(injury_detail) like 'concussion%' then 'head'
        when reason_group <> 'injury' then null
        else trim(regexp_replace(site, '^(left|right|bilateral) ', ''))
    end as body_part,
    case
        when lower(injury_detail) like 'concussion%' then 'concussion'
        when reason_group <> 'injury' or kind_raw is null or kind_raw in ('', '-', 'injury', 'nwt')
            or kind_raw = site or site like '%' || kind_raw or kind_raw like '_. %' then null
        else kind_raw
    end as injury_kind
from parsed
