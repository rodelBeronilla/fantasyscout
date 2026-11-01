{#
  The newest headline about each player with a flag (injury, return, role...) in the last three
  days: what the Board and Streamers show beside the injury tag. One row per player.
#}

select
    league,
    stats_player_id,
    news_flag,
    headline as news_headline,
    published_date as news_date
from {{ ref('fct_player_news') }}
where news_flag is not null and published_date >= {{ add_days(as_of_date(), -3) }}
qualify row_number() over (partition by league, stats_player_id order by published_at desc, article_id) = 1
