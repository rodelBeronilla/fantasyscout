{#
  The headlines about each player for the player page: ESPN articles tagged with the player and
  at most three others (a roundup that tags many players says little about any one of them), one
  row per article and player, newest first. The site shows the headline, its date and a link to
  the story on ESPN, and the flag the headline's wording gives.
#}

select
    {{ sk(['league', 'article_id', 'stats_player_id']) }} as player_news_sk,
    league,
    stats_player_id,
    article_id,
    article_type,
    headline,
    url,
    published_at,
    published_date,
    news_flag
from {{ ref('player_news') }}
where stats_player_id is not null
    and athletes_tagged <= 4
    and url is not null
qualify row_number() over (partition by league, article_id, stats_player_id order by published_at desc) = 1
