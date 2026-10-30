{{ config(severity='warn', tags=['quality']) }}

-- Arena cities in the schedule that the venues seed cannot place: their games get no travel or
-- altitude context until the city is added to seeds/venues.csv.
select s.league, s.season, s.arena_city, count(*) as games
from {{ ref('schedule') }} as s
left join {{ ref('venues') }} as v on lower(v.city) = lower(s.arena_city)
where s.game_type in ('regular', 'play_in', 'playoffs', 'tournament_final')
    and coalesce(s.arena_city, '') <> ''
    and v.city is null
group by s.league, s.season, s.arena_city
