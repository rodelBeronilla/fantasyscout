{#
  The league players each YouTube item names (#851): one row per item and player, for the claims
  extractor (ai/claims.py). An item is a video's title and description (part 'video'), or 30
  seconds of its transcript (part 'transcript', silver.youtube_transcripts). Nothing on the site
  shows it; it leaves the lakehouse only as the owner-only Parquet the claims inputs read, and a
  transcript chunk's row carries which players it names, never its words: the extractor reads
  those from the landed transcript on the home runner (ai/claims.py), so a transcript is never
  in the published build or in a workflow's artifact.

  A player is named as in an outlet's feed item (gold.fct_player_rss_item, macros/mentions.sql):
  his full name's words, whole, in the item's text; a name only he carries in the league; seen in
  the league within 400 days. A transcript chunk that says only "he" names no one, so a claim is
  only ever about a player the chunk names.
#}

with videos as (

    select
        league,
        season,
        channel,
        channel_name,
        video_id,
        video_id as item_id,
        'video' as part,
        cast(null as integer) as start_seconds,
        title,
        title || coalesce(chr(10) || description, '') as text,
        link,
        published_at,
        first_seen_at,
        published_date
    from {{ ref('youtube_videos') }}

),

chunks as (

    select
        league,
        season,
        channel,
        channel_name,
        video_id,
        chunk_id as item_id,
        'transcript' as part,
        start_seconds,
        title,
        text,
        link,
        published_at,
        first_seen_at,
        published_date
    from {{ ref('youtube_transcripts') }}

),

items as (

    select
        i.*,
        {{ mention_words('i.text') }} as words
    from (select * from videos union all select * from chunks) as i
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
        i.video_id,
        i.channel,
        i.channel_name,
        i.part,
        i.start_seconds,
        i.title,
        i.text,
        i.link,
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
    {{ sk(['league', 'item_id', 'stats_player_id']) }} as player_youtube_item_sk,
    league,
    season,
    stats_player_id,
    full_name,
    item_id,
    video_id,
    channel,
    channel_name,
    part,
    start_seconds,
    title,
    -- a transcript's words never leave the lakehouse: the extractor reads them from the landing
    case when part = 'video' then text end as text,
    link,
    published_at,
    first_seen_at,
    published_date,
    count(*) over (partition by league, item_id) as players_named
from linked
