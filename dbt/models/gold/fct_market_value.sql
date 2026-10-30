{#
  The fantasy market's view of each player, from ESPN fantasy, linked to the league player id
  through the player crosswalk:
  - market_rank: the order ESPN drafters take players in, by average draft position, among
    players with a real one. Out of season the WNBA gives most players one placeholder value;
    a value shared by more than half the players is taken as that placeholder and left out.
  - ownership_bucket: how widely ESPN leagues roster the player: most (70% or more), many (40 to
    70), some (10 to 40), few (1 to 10), rare (under 1).
  The raw shares and positions stay in this table; the site shows the rank and the bucket.
#}

with market as (

    select m.*, x.stats_player_id
    from {{ ref('espn_fantasy_market') }} as m
    join {{ ref('player_xwalk') }} as x on x.league = m.league and x.espn_player_id = m.espn_player_id

),

adp_counts as (

    select league, average_draft_position, count(*) as players
    from market
    where average_draft_position is not null
    group by league, average_draft_position

),

placeholders as (

    select c.league, c.average_draft_position as placeholder_adp
    from adp_counts as c
    join (select league, sum(players) as players from adp_counts group by league) as t on t.league = c.league
    where c.players * 2 > t.players

),

ranked as (

    select
        m.*,
        m.average_draft_position is not null
            and (p.placeholder_adp is null or m.average_draft_position < p.placeholder_adp) as has_real_adp
    from market as m
    left join placeholders as p on p.league = m.league

)

select
    {{ sk(['league', 'stats_player_id']) }} as market_value_sk,
    league,
    season,
    stats_player_id,
    espn_player_id,
    case
        when has_real_adp then row_number() over (partition by league, has_real_adp order by average_draft_position, espn_player_id)
    end as market_rank,
    case
        when coalesce(percent_owned, 0) >= 70 then 'most'
        when percent_owned >= 40 then 'many'
        when percent_owned >= 10 then 'some'
        when percent_owned >= 1 then 'few'
        else 'rare'
    end as ownership_bucket,
    percent_owned,
    percent_started,
    average_draft_position,
    auction_value_average,
    percent_owned_change,
    observed_date
from ranked
qualify row_number() over (partition by league, stats_player_id order by coalesce(percent_owned, 0) desc) = 1
