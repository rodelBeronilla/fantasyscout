{#
  Defense vs position (#749): what each team gives up to guards, forwards and centers. Every game
  of ten minutes or more an opponent played against the team, valued on the board's z_total scale
  (int_player_game_value), averaged per position: the first letter of the player's listed
  position (a G-F counts as a guard). vs_average is that less the league's average for the
  position, so a positive figure is a soft matchup; rank 1 gives up the most.
#}

with valued as (

    select
        v.league,
        v.season,
        v.game_id,
        v.team_id,
        v.game_value,
        upper(substr(d.position, 1, 1)) as position
    from {{ ref('int_player_game_value') }} as v
    join {{ ref('dim_player') }} as d on d.player_sk = v.player_sk
    where v.minutes >= 10

),

allowed as (

    select
        v.league,
        v.season,
        tg.opponent_team_id as team_id,
        max(tg.opponent_abbreviation) as team_abbreviation,
        v.position,
        count(distinct v.game_id) as games,
        count(*) as player_games,
        avg(v.game_value) as value_allowed
    from valued as v
    join {{ ref('fct_team_game') }} as tg
        on tg.league = v.league and tg.game_id = v.game_id and tg.team_id = v.team_id
    where v.position in ('G', 'F', 'C')
    group by v.league, v.season, tg.opponent_team_id, v.position

),

league_average as (

    select
        league,
        season,
        position,
        sum(value_allowed * player_games) / nullif(sum(player_games), 0) as average_value
    from allowed
    group by league, season, position

)

select
    {{ sk(['a.league', 'a.season', 'a.team_id', 'a.position']) }} as dvp_sk,
    a.league,
    a.season,
    a.team_id,
    a.team_abbreviation,
    a.position,
    a.games,
    a.player_games,
    a.value_allowed,
    a.value_allowed - la.average_value as vs_average,
    rank() over (partition by a.league, a.season, a.position order by a.value_allowed desc) as rank_allowed
from allowed as a
join league_average as la on la.league = a.league and la.season = a.season and la.position = a.position
