{#
  Player prop lines from both sources, one row per league, game, player, market, source,
  bookmaker and snapshot (one run of the reports ingest, keyed by its Eastern date and hour).
  Private (ADR 0008): a model input and an analysis aid, never on a public page or in the public
  JSON, and never a pick.

  - Prices. The over and under come as American odds, and each implies a probability: -150
    implies 150 / 250 = 0.6, +130 implies 100 / 230. The two add up to more than one, and the
    excess is the bookmaker's margin (vig). over_prob_no_vig divides it out: over / (over + under).
  - Markets. ESPN's prop types and The Odds API's market keys share one set of names: points,
    rebounds, assists, threes, steals, blocks, turnovers, and the combinations ESPN quotes.
  - Games. An ESPN event takes the league game id from the game crosswalk once the game is
    played. Before then it comes from the schedule: the same two teams (through team_xwalk, either
    way round) on the same Eastern date. The Odds API names teams in full ("Los Angeles
    Clippers"). A name links to the league team with that full name or, failing that, the team
    whose nickname it ends with, the longest nickname winning ("Hornets" over "Nets"). The schedule
    match then works the same way.
  - Players. ESPN athletes link through the player crosswalk. The Odds API gives only the name,
    which is matched the way transactions and the waiver trend match names: the league name with
    its suffix kept, or both names without suffixes. A player on one of the game's two teams wins
    over a namesake elsewhere, then a player on a roster. A name that still matches more than one
    player is left unlinked.
  - Repeated quotes. When a bookmaker quotes one player's market at more than one line in a
    snapshot, the line with the most even prices is kept: the main line, not an alternate.
#}

with espn as (

    select
        league,
        season,
        'espn' as source,
        bookmaker,
        event_id as source_event_id,
        snapshot_key,
        fetched_at,
        commence_at,
        cast(game_date_et as date) as game_date,
        espn_home_team_id,
        espn_away_team_id,
        cast(null as string) as home_team_name,
        cast(null as string) as away_team_name,
        espn_player_id,
        cast(null as string) as source_player_name,
        espn_player_id as source_player_key,
        case prop_type
            when 'Total Points' then 'points'
            when 'Total Rebounds' then 'rebounds'
            when 'Total Assists' then 'assists'
            when 'Total 3-Point Field Goals' then 'threes'
            when 'Total Steals' then 'steals'
            when 'Total Blocks' then 'blocks'
            when 'Total Turnovers' then 'turnovers'
            when 'Total Points and Rebounds' then 'points_rebounds'
            when 'Total Points and Assists' then 'points_assists'
            when 'Total Assists and Rebounds' then 'rebounds_assists'
            when 'Total Points, Rebounds, and Assists' then 'points_rebounds_assists'
            when 'Total Steals and Blocks' then 'steals_blocks'
        end as market,
        try_cast(line as double) as line,
        try_cast(open_line as double) as open_line,
        try_cast(over_odds as integer) as over_price,
        try_cast(under_odds as integer) as under_price,
        try_cast(over_open_odds as integer) as over_open_price,
        try_cast(under_open_odds as integer) as under_open_price,
        last_updated,
        _ingest_date,
        _source_file
    from {{ ref('espn_prop_bets') }}
    where event_id is not null and espn_player_id is not null

),

odds_api as (

    select
        league,
        season,
        'odds_api' as source,
        bookmaker,
        event_id as source_event_id,
        snapshot_key,
        fetched_at,
        commence_at,
        cast(game_date_et as date) as game_date,
        cast(null as string) as espn_home_team_id,
        cast(null as string) as espn_away_team_id,
        home_team_name,
        away_team_name,
        cast(null as string) as espn_player_id,
        player_name as source_player_name,
        player_name as source_player_key,
        case market_key
            when 'player_points' then 'points'
            when 'player_rebounds' then 'rebounds'
            when 'player_assists' then 'assists'
            when 'player_threes' then 'threes'
            when 'player_steals' then 'steals'
            when 'player_blocks' then 'blocks'
            when 'player_turnovers' then 'turnovers'
        end as market,
        try_cast(line as double) as line,
        cast(null as double) as open_line,
        try_cast(over_odds as integer) as over_price,
        try_cast(under_odds as integer) as under_price,
        cast(null as integer) as over_open_price,
        cast(null as integer) as under_open_price,
        last_updated,
        _ingest_date,
        _source_file
    from {{ ref('odds_api_player_props') }}
    where event_id is not null and player_name is not null and bookmaker is not null

),

priced as (

    select
        *,
        {{ american_to_prob('over_price') }} as over_implied_prob,
        {{ american_to_prob('under_price') }} as under_implied_prob
    from (
        select * from espn
        union all
        select * from odds_api
    ) as unioned
    where market is not null and line is not null

),

-- One quote per bookmaker, event, player, market and snapshot: the most even prices, then the
-- latest landing.
quotes as (

    select *
    from priced
    qualify row_number() over (
        partition by league, source, bookmaker, source_event_id, source_player_key, market, snapshot_key
        order by abs(coalesce(over_implied_prob, 1) - coalesce(under_implied_prob, 0)), _ingest_date desc, _source_file desc, line
    ) = 1

),

team_names as (

    select
        league,
        team_id,
        {{ norm_name('team_name') }} as full_key,
        {{ norm_name('name') }} as nick_key
    from {{ ref('teams') }}
    qualify row_number() over (partition by league, team_id order by season desc) = 1

),

named_teams as (

    select distinct league, home_team_name as team_name from quotes where home_team_name is not null
    union
    select distinct league, away_team_name as team_name from quotes where away_team_name is not null

),

team_candidates as (

    select
        n.league,
        n.team_name,
        t.team_id,
        case when {{ norm_name('n.team_name') }} = t.full_key then 1 else 0 end as full_match,
        length(t.nick_key) as nick_length
    from named_teams as n
    join team_names as t
        on t.league = n.league
        and (
            {{ norm_name('n.team_name') }} = t.full_key
            or (length(t.nick_key) > 0 and {{ norm_name('n.team_name') }} like ('%' || t.nick_key))
        )

),

team_links as (

    select league, team_name, team_id
    from (
        select
            *,
            row_number() over (partition by league, team_name order by full_match desc, nick_length desc, team_id) as rn,
            count(*) over (partition by league, team_name, full_match, nick_length) as tied
        from team_candidates
    ) as ranked
    where rn = 1 and tied = 1

),

events as (

    -- One row per event; a game moved to another date keeps its latest date.
    select
        q.league,
        q.source,
        q.source_event_id,
        max(q.game_date) as game_date,
        max(coalesce(hx.stats_team_id, hn.team_id)) as home_team_id,
        max(coalesce(ax.stats_team_id, an.team_id)) as away_team_id
    from quotes as q
    left join {{ ref('team_xwalk') }} as hx on hx.league = q.league and hx.espn_team_id = q.espn_home_team_id
    left join {{ ref('team_xwalk') }} as ax on ax.league = q.league and ax.espn_team_id = q.espn_away_team_id
    left join team_links as hn on hn.league = q.league and hn.team_name = q.home_team_name
    left join team_links as an on an.league = q.league and an.team_name = q.away_team_name
    group by q.league, q.source, q.source_event_id

),

scheduled as (

    select
        e.league,
        e.source,
        e.source_event_id,
        s.game_id,
        s.season as game_season,
        row_number() over (
            partition by e.league, e.source, e.source_event_id
            order by case when s.home_team_id = e.home_team_id then 0 else 1 end, s.game_id
        ) as rn
    from events as e
    join {{ ref('schedule') }} as s
        on s.league = e.league
        and s.game_date_est = e.game_date
        and (
            (s.home_team_id = e.home_team_id and s.away_team_id = e.away_team_id)
            or (s.home_team_id = e.away_team_id and s.away_team_id = e.home_team_id)
        )

),

event_games as (

    select
        e.league,
        e.source,
        e.source_event_id,
        e.home_team_id,
        e.away_team_id,
        coalesce(gx.game_id, sc.game_id) as game_id,
        coalesce(gx.season, sc.game_season) as game_season
    from events as e
    left join {{ ref('game_xwalk') }} as gx
        on e.source = 'espn' and gx.league = e.league and gx.event_id = e.source_event_id
    left join scheduled as sc
        on sc.league = e.league and sc.source = e.source and sc.source_event_id = e.source_event_id and sc.rn = 1

),

player_names as (

    select
        league,
        player_id,
        team_id,
        coalesce(on_roster, false) as on_roster,
        {{ norm_name('full_name', keep_suffix=true) }} as name_full,
        {{ norm_name('full_name') }} as name_plain
    from {{ ref('players') }}
    where full_name is not null

),

named_players as (

    select distinct q.league, q.source_event_id, q.source_player_name, g.home_team_id, g.away_team_id
    from quotes as q
    join event_games as g
        on g.league = q.league and g.source = q.source and g.source_event_id = q.source_event_id
    where q.source = 'odds_api'

),

name_candidates as (

    select
        n.league,
        n.source_event_id,
        n.source_player_name,
        p.player_id,
        coalesce(p.team_id = n.home_team_id or p.team_id = n.away_team_id, false) as on_game_team,
        (case when p.team_id = n.home_team_id or p.team_id = n.away_team_id then 2 else 0 end)
            + (case when p.on_roster then 1 else 0 end) as score
    from named_players as n
    join player_names as p
        on p.league = n.league
        and (
            p.name_full = {{ norm_name('n.source_player_name', keep_suffix=true) }}
            or p.name_plain = {{ norm_name('n.source_player_name') }}
        )

),

name_links as (

    select league, source_event_id, source_player_name, player_id, on_game_team
    from (
        select
            *,
            row_number() over (partition by league, source_event_id, source_player_name order by score desc, player_id) as rn,
            count(*) over (partition by league, source_event_id, source_player_name, score) as tied
        from name_candidates
    ) as ranked
    where rn = 1 and tied = 1

),

linked as (

    select
        q.*,
        g.game_id,
        coalesce(g.game_season, q.season) as game_season,
        coalesce(px.stats_player_id, nl.player_id) as player_id,
        case
            when px.stats_player_id is not null then 'player_xwalk'
            when nl.player_id is not null and nl.on_game_team then 'name_and_team'
            when nl.player_id is not null then 'name'
        end as player_link,
        {{ espn_ts('q.fetched_at') }} as snapshot_at,
        {{ espn_ts('q.commence_at') }} as commence_ts,
        {{ espn_ts('q.last_updated') }} as line_updated_at
    from quotes as q
    left join event_games as g
        on g.league = q.league and g.source = q.source and g.source_event_id = q.source_event_id
    left join {{ ref('player_xwalk') }} as px
        on q.source = 'espn' and px.league = q.league and px.espn_player_id = q.espn_player_id
    left join name_links as nl
        on q.source = 'odds_api' and nl.league = q.league and nl.source_event_id = q.source_event_id
        and nl.source_player_name = q.source_player_name

)

select
    league || ':' || source || ':' || bookmaker || ':' || source_event_id || ':' || source_player_key
        || ':' || market || ':' || snapshot_key as player_prop_key,
    league,
    game_season as season,
    source,
    bookmaker,
    source_event_id,
    game_id,
    game_date,
    commence_ts as commence_at,
    espn_player_id,
    source_player_name,
    player_id,
    player_link,
    market,
    line,
    open_line,
    over_price,
    under_price,
    over_open_price,
    under_open_price,
    over_implied_prob,
    under_implied_prob,
    over_implied_prob + under_implied_prob - 1 as vig,
    over_implied_prob / nullif(over_implied_prob + under_implied_prob, 0) as over_prob_no_vig,
    snapshot_key,
    snapshot_at,
    line_updated_at,
    coalesce(snapshot_at < commence_ts, false) as is_pre_game,
    _ingest_date
from linked
