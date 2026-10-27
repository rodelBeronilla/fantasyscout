{{ config(partition_by=(['league', 'season'] if target.type == 'databricks' else none)) }}

{# Raw stats `boxscoreadvancedv3` payloads parsed to rows; values stay text until silver.  #}

with files as (

    select *
    from ({{ landing_files('stats', 'boxscoreadvancedv3') }}) as landed
    {{ bronze_incremental_filter() }}

),

players as (

    select
        files.*,
        'home' as side,
        {{ json_text('files.payload', '$.boxScoreAdvanced.homeTeam.teamId') }} as team_id,
        {{ json_text('files.payload', '$.boxScoreAdvanced.homeTeam.teamTricode') }} as team_tricode,
        {{ json_rows('files.payload', '$.boxScoreAdvanced.homeTeam.players') }} as player
    from files
    union all
    select
        files.*,
        'away' as side,
        {{ json_text('files.payload', '$.boxScoreAdvanced.awayTeam.teamId') }} as team_id,
        {{ json_text('files.payload', '$.boxScoreAdvanced.awayTeam.teamTricode') }} as team_tricode,
        {{ json_rows('files.payload', '$.boxScoreAdvanced.awayTeam.players') }} as player
    from files

)

select
    players._source_file,
    players.league,
    players.season,
    players._ingest_date,
    players.request_key,
    {{ sha256('players.payload') }} as _payload_hash,
    {{ json_text('players.payload', '$.boxScoreAdvanced.gameId') }} as game_id,
    {{ json_text('players.payload', '$.boxScoreAdvanced.homeTeamId') }} as home_team_id,
    {{ json_text('players.payload', '$.boxScoreAdvanced.awayTeamId') }} as away_team_id,
    players.side,
    players.team_id,
    players.team_tricode,
        {{ json_text('players.player', '$.personId') }} as person_id,
        {{ json_text('players.player', '$.firstName') }} as first_name,
        {{ json_text('players.player', '$.familyName') }} as family_name,
        {{ json_text('players.player', '$.nameI') }} as name_i,
        {{ json_text('players.player', '$.playerSlug') }} as player_slug,
        {{ json_text('players.player', '$.position') }} as position,
        {{ json_text('players.player', '$.comment') }} as comment,
        {{ json_text('players.player', '$.jerseyNum') }} as jersey_num,
        {{ json_text('players.player', '$.statistics.minutes') }} as minutes,
        {{ json_text('players.player', '$.statistics.estimatedOffensiveRating') }} as estimated_offensive_rating,
        {{ json_text('players.player', '$.statistics.offensiveRating') }} as offensive_rating,
        {{ json_text('players.player', '$.statistics.estimatedDefensiveRating') }} as estimated_defensive_rating,
        {{ json_text('players.player', '$.statistics.defensiveRating') }} as defensive_rating,
        {{ json_text('players.player', '$.statistics.estimatedNetRating') }} as estimated_net_rating,
        {{ json_text('players.player', '$.statistics.netRating') }} as net_rating,
        {{ json_text('players.player', '$.statistics.assistPercentage') }} as assist_percentage,
        {{ json_text('players.player', '$.statistics.assistToTurnover') }} as assist_to_turnover,
        {{ json_text('players.player', '$.statistics.assistRatio') }} as assist_ratio,
        {{ json_text('players.player', '$.statistics.offensiveReboundPercentage') }} as offensive_rebound_percentage,
        {{ json_text('players.player', '$.statistics.defensiveReboundPercentage') }} as defensive_rebound_percentage,
        {{ json_text('players.player', '$.statistics.reboundPercentage') }} as rebound_percentage,
        {{ json_text('players.player', '$.statistics.turnoverRatio') }} as turnover_ratio,
        {{ json_text('players.player', '$.statistics.effectiveFieldGoalPercentage') }} as effective_field_goal_percentage,
        {{ json_text('players.player', '$.statistics.trueShootingPercentage') }} as true_shooting_percentage,
        {{ json_text('players.player', '$.statistics.usagePercentage') }} as usage_percentage,
        {{ json_text('players.player', '$.statistics.estimatedUsagePercentage') }} as estimated_usage_percentage,
        {{ json_text('players.player', '$.statistics.estimatedPace') }} as estimated_pace,
        {{ json_text('players.player', '$.statistics.pace') }} as pace,
        {{ json_text('players.player', '$.statistics.pacePer40') }} as pace_per40,
        {{ json_text('players.player', '$.statistics.possessions') }} as possessions,
        {{ json_text('players.player', '$.statistics.PIE') }} as pie
from players
