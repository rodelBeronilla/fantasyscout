{#
  How fresh each source feed is, per league: the newest day a payload landed for it and how many
  days ago that was, against how often the feed should land while the league is playing. A feed
  that stops keeps its last landing in silver and gold, where it would otherwise look current;
  warn_stale_feeds reports a stale one. Out of season (no game three days either side of today)
  a quiet feed is expected. An unchanged payload lands no new file, so the slower feeds get a
  few days' grace.
#}

{%- set feeds = [
    {'feed': 'League stats schedule', 'model': 'stats_scheduleleaguev2', 'leagues': ['nba', 'wnba'], 'days': 2},
    {'feed': 'League standings', 'model': 'stats_leaguestandingsv3', 'leagues': ['nba', 'wnba'], 'days': 3},
    {'feed': 'ESPN scoreboards and lines', 'model': 'espn_scoreboard', 'leagues': ['nba', 'wnba'], 'days': 2},
    {'feed': 'ESPN injury listing', 'model': 'espn_injuries', 'leagues': ['nba', 'wnba'], 'days': 2},
    {'feed': 'ESPN transactions', 'model': 'espn_transactions', 'leagues': ['nba', 'wnba'], 'days': 3},
    {'feed': 'ESPN fantasy market', 'model': 'espn_fantasy_players', 'leagues': ['nba', 'wnba'], 'days': 2},
    {'feed': 'ESPN headlines', 'model': 'espn_news', 'leagues': ['nba', 'wnba'], 'days': 2},
    {'feed': 'Official injury reports', 'model': 'league_injury_report', 'leagues': ['nba', 'wnba'], 'days': 3},
    {'feed': 'Starting lineups', 'model': 'league_daily_lineups', 'leagues': ['nba'], 'days': 3},
    {'feed': 'Player movement', 'model': 'league_player_movement', 'leagues': ['nba'], 'days': 3},
    {'feed': 'Sleeper trending', 'model': 'sleeper_trending', 'leagues': ['nba'], 'days': 2},
] -%}

with expected as (

    {% for f in feeds %}
    {%- for lg in f['leagues'] %}
    select '{{ f.feed }}' as feed, '{{ f.model }}' as source_model, '{{ lg }}' as league, {{ f.days }} as max_age_days
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

    select league, true as in_season
    from {{ ref('schedule') }}
    where game_date_est >= {{ add_days(eastern_today(), -3) }}
        and game_date_est <= {{ add_days(eastern_today(), 3) }}
    group by league

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
    coalesce(l.payloads, 0) as payloads,
    coalesce(s.in_season, false) as in_season,
    case
        when l.last_landed is null then 'never'
        when not coalesce(s.in_season, false) then 'off_season'
        when {{ days_between('l.last_landed', eastern_today()) }} > e.max_age_days then 'stale'
        else 'fresh'
    end as status,
    {{ now_ts() }} as checked_at
from expected as e
left join landed as l on l.source_model = e.source_model and l.league = e.league
left join in_season as s on s.league = e.league
