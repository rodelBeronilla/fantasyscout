{#
  How fresh each source feed is, per league: the newest day a payload landed for it and how many
  days ago that was, against how often the feed should land while the league is playing. A feed
  that stops keeps its last landing in silver and gold, where it would otherwise look current;
  warn_stale_feeds reports a stale one. Out of season (no game three days either side of today)
  a quiet feed is expected. An unchanged payload lands no new file, so the slower feeds get a
  few days' grace: a roster or a player directory changes some days, not every day.

  Every landed feed is here. A feed landed from one payload that several bronze models read (the
  ESPN game summary) is listed once, by one of them. A feed that needs a key the repository may
  not have yet (The Odds API) is optional: never having landed is 'unconfigured', not 'never'.
  The core feeds (core: true) are the ones the board cannot do without; assert_core_feeds_fresh
  blocks the publish gate when one of them is stale by more than two days past its allowance.

  A feed the ingest no longer lands is not listed: the per-game advanced box score
  (stats_boxscoreadvancedv3) was replaced by the season-level player game logs, which carry the
  same measures, so it stopped on purpose on 2026-10-27; its bronze model stays for the seasons it
  landed (#394).
#}

{%- set feeds = [
    {'feed': 'League stats schedule', 'model': 'stats_scheduleleaguev2', 'leagues': ['nba', 'wnba'], 'days': 2, 'core': true},
    {'feed': 'League team game log', 'model': 'stats_leaguegamelog', 'leagues': ['nba', 'wnba'], 'days': 2, 'core': true},
    {'feed': 'League box scores', 'model': 'stats_boxscoretraditionalv3', 'leagues': ['nba', 'wnba'], 'days': 2, 'core': true},
    {'feed': 'League play-by-play', 'model': 'stats_playbyplayv3', 'leagues': ['nba', 'wnba'], 'days': 2, 'core': true},
    {'feed': 'League shot charts', 'model': 'stats_shotchartdetail', 'leagues': ['nba', 'wnba'], 'days': 2, 'core': true},
    {'feed': 'League player game logs', 'model': 'stats_playergamelogs', 'leagues': ['nba', 'wnba'], 'days': 2},
    {'feed': 'League player usage logs', 'model': 'stats_playergamelogs_usage', 'leagues': ['nba', 'wnba'], 'days': 2},
    {'feed': 'League player misc logs', 'model': 'stats_playergamelogs_misc', 'leagues': ['nba', 'wnba'], 'days': 2},
    {'feed': 'League standings', 'model': 'stats_leaguestandingsv3', 'leagues': ['nba', 'wnba'], 'days': 3},
    {'feed': 'League rosters', 'model': 'stats_commonteamroster', 'leagues': ['nba', 'wnba'], 'days': 7, 'core': true},
    {'feed': 'League player directory', 'model': 'stats_commonallplayers', 'leagues': ['nba', 'wnba'], 'days': 14},
    {'feed': 'NBA player tracking', 'model': 'stats_leaguedashptstats_passing', 'leagues': ['nba'], 'days': 3},
    {'feed': 'NBA hustle stats', 'model': 'stats_leaguehustlestatsplayer', 'leagues': ['nba'], 'days': 3},
    {'feed': 'ESPN scoreboards and lines', 'model': 'espn_scoreboard', 'leagues': ['nba', 'wnba'], 'days': 2, 'core': true},
    {'feed': 'ESPN game summaries', 'model': 'espn_summary_players', 'leagues': ['nba', 'wnba'], 'days': 2},
    {'feed': 'ESPN rosters', 'model': 'espn_roster', 'leagues': ['nba', 'wnba'], 'days': 7},
    {'feed': 'ESPN injury listing', 'model': 'espn_injuries', 'leagues': ['nba', 'wnba'], 'days': 2},
    {'feed': 'ESPN transactions', 'model': 'espn_transactions', 'leagues': ['nba', 'wnba'], 'days': 3},
    {'feed': 'ESPN fantasy market', 'model': 'espn_fantasy_players', 'leagues': ['nba', 'wnba'], 'days': 2},
    {'feed': 'ESPN headlines', 'model': 'espn_news', 'leagues': ['nba', 'wnba'], 'days': 2},
    {'feed': 'ESPN prop lines', 'model': 'espn_prop_bets', 'leagues': ['nba', 'wnba'], 'days': 3},
    {'feed': 'The Odds API prop lines', 'model': 'odds_api_player_props', 'leagues': ['nba', 'wnba'], 'days': 3, 'optional': true},
    {'feed': 'Official injury reports', 'model': 'league_injury_report', 'leagues': ['nba', 'wnba'], 'days': 3},
    {'feed': 'Referee assignments', 'model': 'league_referee_assignments', 'leagues': ['nba', 'wnba'], 'days': 3},
    {'feed': 'Starting lineups', 'model': 'league_daily_lineups', 'leagues': ['nba'], 'days': 3},
    {'feed': 'Player movement', 'model': 'league_player_movement', 'leagues': ['nba'], 'days': 3},
    {'feed': 'Sleeper player directory', 'model': 'sleeper_players', 'leagues': ['nba'], 'days': 7},
    {'feed': 'Sleeper trending', 'model': 'sleeper_trending', 'leagues': ['nba'], 'days': 2},
    {'feed': 'Outlet RSS feeds', 'model': 'rss_items', 'leagues': ['nba', 'wnba'], 'days': 3},
    {'feed': 'YouTube channel videos', 'model': 'youtube_video_items', 'leagues': ['nba'], 'days': 7},
] -%}

with expected as (

    {% for f in feeds %}
    {%- for lg in f['leagues'] %}
    select '{{ f.feed }}' as feed, '{{ f.model }}' as source_model, '{{ lg }}' as league, {{ f.days }} as max_age_days,
        {{ 'true' if f.get('core') else 'false' }} as is_core, {{ 'true' if f.get('optional') else 'false' }} as is_optional
    {%- if not loop.last %}
    union all
    {%- endif %}
    {%- endfor %}
    {%- if not loop.last %}
    union all
    {%- endif %}
    {% endfor %}

),

landed as (

    {% for f in feeds %}
    select '{{ f.model }}' as source_model, league, max(cast(_ingest_date as date)) as last_landed,
        count(distinct _source_file) as payloads
    from {{ ref(f.model) }}
    group by league
    {%- if not loop.last %}
    union all
    {%- endif %}
    {% endfor %}

),

in_season as (

    -- a scheduled game within three days either side of today (int_league_season_state)
    select league, in_season_window as in_season
    from {{ ref('int_league_season_state') }}
    where in_season_window

)

select
    e.league || ':' || e.source_model as feed_key,
    e.league,
    e.feed,
    e.source_model,
    l.last_landed,
    -- the landing date is the UTC day of the run, which can be a day ahead of the Eastern date
    greatest({{ days_between('l.last_landed', eastern_today()) }}, 0) as age_days,
    e.max_age_days,
    e.is_core,
    coalesce(l.payloads, 0) as payloads,
    coalesce(s.in_season, false) as in_season,
    case
        when l.last_landed is null and e.is_optional then 'unconfigured'
        when l.last_landed is null then 'never'
        when not coalesce(s.in_season, false) then 'off_season'
        when {{ days_between('l.last_landed', eastern_today()) }} > e.max_age_days then 'stale'
        else 'fresh'
    end as status,
    {{ now_ts() }} as checked_at
from expected as e
left join landed as l on l.source_model = e.source_model and l.league = e.league
left join in_season as s on s.league = e.league
