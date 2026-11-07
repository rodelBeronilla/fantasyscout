{# One row per rostered player per team per season, typed (height in inches, birth date a date). Latest landing wins. #}

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
    -- "6-4" to inches; a height the roster writes any other way is null
    try_cast(split_part(height, '-', 1) as integer) * 12 + try_cast(split_part(height, '-', 2) as integer) as height_inches,
    try_cast(weight as integer) as weight_lbs,
    -- "MAR 16, 2000" to a date
    {{ stats_birth_date('birth_date') }} as birth_date,
    try_cast(age as integer) as age,
    exp as experience,
    school,
    how_acquired,
    _ingest_date,
    _source_file
from ({{ latest_snapshot(ref('stats_commonteamroster'), observed=true) }}) as newest_stats_commonteamroster
where team_id is not null and player_id is not null
{{ latest_landing(['league', 'season', 'team_id', 'player_id']) }}
