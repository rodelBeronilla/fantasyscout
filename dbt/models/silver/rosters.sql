{# One row per rostered player per team per season. Latest landing wins. #}

select
    league,
    season,
    team_id,
    player_id,
    league || ':' || season || ':' || team_id || ':' || player_id as roster_key,
    player as player_name,
    nickname,
    player_slug,
    num as jersey,
    {{ clean_text('position') }} as position,
    height,
    try_cast(weight as integer) as weight_lbs,
    birth_date,
    try_cast(age as integer) as age,
    exp as experience,
    school,
    how_acquired,
    _ingest_date,
    _source_file
from ({{ latest_snapshot(ref('stats_commonteamroster')) }}) as newest_stats_commonteamroster
where team_id is not null and player_id is not null
{{ latest_landing(['league', 'season', 'team_id', 'player_id']) }}
