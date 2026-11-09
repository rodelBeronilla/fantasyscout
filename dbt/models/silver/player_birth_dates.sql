{#
  One row per player per league with the birth date the stats rosters give (#918). Identity
  reference data, like a name or an id, so a point-in-time build does not cut it (ADR 0018): it
  reads every roster landing, whatever day it landed, where silver.rosters keeps only the
  landings known before the cut. A birth date is fixed before a player's first game, so a landing
  from after the cut tells nothing that wasn't so before it, and the build only looks up players
  it already knows from games and moves before the cut (int_known_roster). The newest landing
  that gives a date wins, so a corrected date replaces a wrong one.
#}

select
    league,
    player_id,
    league || ':' || player_id as player_key,
    {{ stats_birth_date('birth_date') }} as birth_date
from {{ ref('stats_commonteamroster') }}
where player_id is not null
    and {{ stats_birth_date('birth_date') }} is not null
{{ latest_landing(['league', 'player_id']) }}
