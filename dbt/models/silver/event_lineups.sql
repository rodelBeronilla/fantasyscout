{#
  The five players on the floor for each team at every play-by-play action.

  The league's play-by-play names only the player leaving on a substitution ("SUB: Key FOR
  Fagbenle", with the leaving player's id); the player coming on is matched by surname to the
  game's box score for that team. When two teammates share a surname the feed adds the start of
  the given name ("SUB: K. Mitchell FOR T. Mitchell", "SUB: Jay. Williams FOR Mitchell"), which
  must match the given name too; names the feed
  writes in the other order ("Xu" for Han Xu) match by given name, and a name with more words
  ("J.J. Redick") by its last word. A player's time on the floor is a set of intervals within a
  period: a period starter is on from the start, a substitution in opens an interval and one
  out closes it; the action that is the substitution belongs to the lineup before it. Order is
  the game clock within the period, with the action number only breaking ties: the feed logs
  some substitutions late, so action numbers alone are not chronological.

  Period starters: period 1 from the box score (starters carry a position). Later periods are
  inferred: a player is on at the start of a period when, in that period, their first
  substitution is out, or they record an action before any substitution in. A player who plays
  a whole period without an action or a substitution is not seen; lineup_complete (five a
  side) is false for those actions, and the share of complete lineups is checked per season.
#}

with box as (

    select league, game_id, team_id, player_id, side, starter,
        {{ norm_name('family_name') }} as norm_family, {{ norm_name('first_name') }} as norm_first,
        {{ norm_name('family_name', keep_suffix=true) }} as full_family
    from {{ ref('player_game_box') }}

),

events as (

    select
        league, season, game_id, event_key, period, team_id, player_id, action_type, description,
        row_number() over (
            partition by league, game_id
            order by period,
                try_cast(substr(clock, 3, 2) as integer) * 60 + try_cast(substr(clock, 6, 5) as double) desc,
                action_number
        ) as action_number
    from {{ ref('events') }}

),

subs as (

    select
        e.league, e.game_id, e.period, e.action_number, e.team_id,
        e.player_id as out_id,
        {{ norm_name("regexp_replace(e.in_raw, '^[A-Za-z]+[.] +', '')") }} as in_norm,
        nullif({{ norm_name("regexp_extract(e.in_raw, '^([A-Za-z]+)[.] ', 1)") }}, '') as in_prefix,
        {{ norm_name("regexp_replace(e.in_raw, '^[A-Za-z]+[.] +', '')", keep_suffix=true) }} as in_full,
        {{ norm_name("regexp_extract(e.in_raw, '([^ ]+)$', 1)") }} as in_last
    from (
        select *, regexp_extract(description, 'SUB: (.+) FOR ', 1) as in_raw
        from events
        where action_type = 'Substitution'
    ) as e

),

subs_in as (

    -- rank 0: surname (and the given-name prefix, when there is one), suffix and all, so that
    -- "Carter Jr." is not his teammate Carter; 1: the same without the suffix; 2: given name, for
    -- names the feed writes in the other order; 3: the last word of a longer name, only without
    -- a prefix
    select league, game_id, period, action_number, team_id, in_id
    from (
        select s.league, s.game_id, s.period, s.action_number, s.team_id, b.player_id as in_id,
            case
                when (s.in_prefix is null or substr(b.norm_first, 1, length(s.in_prefix)) = s.in_prefix)
                    and b.full_family = s.in_full then 0
                when (s.in_prefix is null or substr(b.norm_first, 1, length(s.in_prefix)) = s.in_prefix)
                    and b.norm_family = s.in_norm then 1
                when b.norm_first = s.in_norm then 2
                when s.in_prefix is null and b.norm_family = s.in_last then 3
            end as match_rank
        from subs as s
        join box as b
            on b.league = s.league and b.game_id = s.game_id and b.team_id = s.team_id
    ) as m
    where match_rank is not null
    qualify row_number() over (
        partition by league, game_id, action_number
        order by match_rank, in_id
    ) = 1

),

toggles as (

    select league, game_id, period, team_id, out_id as player_id, action_number, 'out' as kind from subs
    union all
    select league, game_id, period, team_id, in_id as player_id, action_number, 'in' as kind from subs_in

),

first_toggle as (

    select league, game_id, period, team_id, player_id, action_number, kind
    from toggles
    qualify row_number() over (partition by league, game_id, period, team_id, player_id order by action_number) = 1

),

first_action as (

    select league, game_id, period, team_id, player_id, min(action_number) as action_number
    from events
    where action_type <> 'Substitution' and player_id is not null and player_id <> '0' and team_id is not null
    group by league, game_id, period, team_id, player_id

),

periods as (

    select league, game_id, period from events where period is not null group by league, game_id, period

),

period_starters as (

    -- period 1: the box score's starters
    select p.league, p.game_id, p.period, b.team_id, b.player_id
    from periods as p
    join box as b on b.league = p.league and b.game_id = p.game_id and b.starter
    where p.period = 1
    union
    -- later periods: first substitution is out, or an action before any substitution in
    select ft.league, ft.game_id, ft.period, ft.team_id, ft.player_id
    from first_toggle as ft
    where ft.period > 1 and ft.kind = 'out'
    union
    select fa.league, fa.game_id, fa.period, fa.team_id, fa.player_id
    from first_action as fa
    left join first_toggle as ft
        on ft.league = fa.league and ft.game_id = fa.game_id and ft.period = fa.period
        and ft.team_id = fa.team_id and ft.player_id = fa.player_id
    where fa.period > 1 and (ft.player_id is null or ft.kind = 'out' or fa.action_number < ft.action_number)

),

opens as (

    select league, game_id, period, team_id, player_id, lo,
        row_number() over (partition by league, game_id, period, team_id, player_id order by lo) as k
    from (
        select league, game_id, period, team_id, player_id, -1 as lo from period_starters
        union all
        select league, game_id, period, team_id, player_id, action_number as lo from toggles where kind = 'in'
    ) as o

),

closes as (

    select league, game_id, period, team_id, player_id, action_number as hi,
        row_number() over (partition by league, game_id, period, team_id, player_id order by action_number) as k
    from toggles
    where kind = 'out'

),

intervals as (

    select o.league, o.game_id, o.period, o.team_id, o.player_id, o.lo, coalesce(c.hi, 1000000) as hi
    from opens as o
    left join closes as c
        on c.league = o.league and c.game_id = o.game_id and c.period = o.period
        and c.team_id = o.team_id and c.player_id = o.player_id and c.k = o.k

),

sides as (

    select league, game_id, team_id, max(side) as side from box group by league, game_id, team_id

),

on_floor as (

    select e.league, e.season, e.game_id, e.event_key, s.side, i.player_id
    from events as e
    join intervals as i
        on i.league = e.league and i.game_id = e.game_id and i.period = e.period
        and e.action_number > i.lo and e.action_number <= i.hi
    join sides as s
        on s.league = i.league and s.game_id = i.game_id and s.team_id = i.team_id

),

per_side as (

    select league, season, game_id, event_key, side, {{ sorted_join('player_id') }} as lineup, count(*) as players
    from on_floor
    group by league, season, game_id, event_key, side

)

select
    league,
    season,
    game_id,
    event_key,
    max(case when side = 'home' then lineup end) as lineup_home,
    max(case when side = 'away' then lineup end) as lineup_away,
    max(case when side = 'home' then players else 0 end) = 5
        and max(case when side = 'away' then players else 0 end) = 5 as lineup_complete
from per_side
group by league, season, game_id, event_key
