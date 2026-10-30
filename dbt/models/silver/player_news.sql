{#
  ESPN's headlines per player: one row per article and tagged athlete, the latest landing of each,
  linked to the league player id through the player crosswalk (null when unlinked). athletes_tagged
  counts the players an article is tagged with: a roundup tags many, a story about the player few.
  news_flag sorts the headline by its wording, first match wins:
    out_for_season  out for the season, season-ending
    surgery         surgery, a scope or a procedure
    minutes_limit   a minutes restriction or limit
    return          returns, is cleared or activated, makes a debut
    injury          an injury in brackets ("(ankle)"), sprains, strains, fractures, to miss, ruled out
    g_league        a G League assignment
    role            benched, moved to the bench, a new starter, out of the rotation
#}

with latest as (

    select *
    from {{ ref('espn_news') }}
    where article_id is not null and espn_player_id is not null and headline is not null
    qualify row_number() over (
        partition by league, article_id, espn_player_id order by _ingest_date desc, _source_file desc
    ) = 1

),

counted as (

    select
        latest.*,
        count(*) over (partition by league, article_id) as athletes_tagged,
        lower(headline) as h
    from latest

)

select
    c.league || ':' || c.article_id || ':' || c.espn_player_id as player_news_key,
    c.league,
    c.season,
    c.article_id,
    c.article_type,
    c.espn_player_id,
    x.stats_player_id,
    c.athlete_name,
    c.headline,
    {{ espn_ts('c.published_at') }} as published_at,
    {{ utc_to_eastern_date('c.published_at') }} as published_date,
    c.url,
    c.athletes_tagged,
    case
        when {{ matches('c.h', 'out for (the )?season|season-ending') }} then 'out_for_season'
        when {{ matches('c.h', 'surgery|scope|procedure') }} then 'surgery'
        when {{ matches('c.h', 'minutes (restriction|limit)') }} then 'minutes_limit'
        when {{ matches('c.h', 'return|cleared|activated|debut') }} then 'return'
        when {{ matches('c.h', '[(][a-z -]+[)]|injur|sprain|strain|fracture|torn|to miss|ruled out|day-to-day') }} then 'injury'
        when {{ matches('c.h', 'g league') }} then 'g_league'
        when {{ matches('c.h', 'bench|to start|starting lineup|rotation') }} then 'role'
    end as news_flag
from counted as c
left join {{ ref('player_xwalk') }} as x on x.league = c.league and x.espn_player_id = c.espn_player_id
