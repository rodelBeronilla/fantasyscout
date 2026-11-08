{{ config(tags=['feed_reports']) }}

{#
  The league players each outlet's feed item names (#812): one row per item and player, for the
  claims extractor (ai/claims.py), which reads the headline and, where the feed's terms allow,
  its summary. Nothing on the site shows it.

  A player is named when his full name's words appear, whole, in the headline or summary
  (macros/mentions.sql): accents, case, punctuation and a generational suffix aside, and never as
  part of a longer word. Only a name one player in the league carries counts, and only for a
  player seen in the league (a game, or a roster) within 400 days of the item, so a namesake from
  years ago does not take the mention. An item that names no such player has no row, and so
  yields no claim.
#}

with items as (

    select
        i.*,
        {{ mention_words("i.title || ' ' || coalesce(i.summary, '')") }} as words
    from {{ ref('rss_feed_items') }} as i
    where {{ known_before('i.published_date') }}

),

players as (

    select
        league,
        stats_player_id,
        full_name,
        {{ name_words('full_name') }} as words,
        coalesce(last_game_date, valid_from) as last_seen
    from {{ ref('dim_player') }}
    where is_current and full_name is not null

),

named_once as (

    select league, words
    from players
    where length(trim(words)) > 0 and position(' ' in trim(words)) > 0
    group by league, words
    having count(*) = 1

),

linked as (

    select
        i.league,
        i.season,
        p.stats_player_id,
        p.full_name,
        i.item_id,
        i.feed_id,
        i.outlet,
        i.feed_team,
        i.feed_keep,
        i.title,
        i.link,
        i.summary,
        i.published_at,
        i.first_seen_at,
        i.published_date
    from items as i
    join players as p
        on p.league = i.league
        and position(p.words in i.words) > 0
        and p.last_seen >= {{ add_days('i.published_date', -400) }}
    join named_once as n on n.league = p.league and n.words = p.words

)

select
    {{ sk(['league', 'item_id', 'stats_player_id']) }} as player_rss_item_sk,
    league,
    season,
    stats_player_id,
    full_name,
    item_id,
    feed_id,
    outlet,
    feed_team,
    feed_keep,
    title,
    link,
    summary,
    published_at,
    first_seen_at,
    published_date,
    count(*) over (partition by league, item_id) as players_named
from linked
