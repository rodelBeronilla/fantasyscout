{#
  Transactions for the site: the NBA's movement feed, which names the player, and ESPN's feed for
  the WNBA and for the NBA moves the league's feed does not carry (G League assignments and
  recalls, suspensions). Each with the team's abbreviation.
#}

with picked as (

    select *
    from {{ ref('transactions') }}
    where source = 'nba'
        or league <> 'nba'
        or move_type in ('g_league', 'recall', 'suspension', 'other')

),

team_names as (

    select league, team_id, abbreviation
    from {{ ref('teams') }}
    qualify row_number() over (partition by league, team_id order by season desc) = 1

)

select
    {{ sk(['p.transaction_key']) }} as transaction_sk,
    p.league,
    p.transaction_date,
    p.team_id,
    coalesce(t.abbreviation, p.source_team_abbreviation) as team_abbreviation,
    p.player_id,
    p.move_type,
    p.description,
    p.source
from picked as p
left join team_names as t on t.league = p.league and t.team_id = p.team_id
