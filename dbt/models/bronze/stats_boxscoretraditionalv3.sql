{{ config(partition_by=(['league', 'season'] if target.type == 'databricks' else none)) }}

{# Raw stats `boxscoretraditionalv3` payloads parsed to rows; values stay text until silver.  #}

with files as (

    select *
    from ({{ landing_files('stats', 'boxscoretraditionalv3') }}) as landed
    {{ bronze_incremental_filter() }}

),

players as (

    select
        files.*,
        'home' as side,
        {{ json_text('files.payload', '$.boxScoreTraditional.homeTeam.teamId') }} as team_id,
        {{ json_text('files.payload', '$.boxScoreTraditional.homeTeam.teamTricode') }} as team_tricode,
        {{ json_rows('files.payload', '$.boxScoreTraditional.homeTeam.players') }} as player
    from files
    union all
    select
        files.*,
        'away' as side,
        {{ json_text('files.payload', '$.boxScoreTraditional.awayTeam.teamId') }} as team_id,
        {{ json_text('files.payload', '$.boxScoreTraditional.awayTeam.teamTricode') }} as team_tricode,
        {{ json_rows('files.payload', '$.boxScoreTraditional.awayTeam.players') }} as player
    from files

)

select
    players._source_file,
    players.league,
    players.season,
    players._ingest_date,
    players.request_key,
    {{ sha256('players.payload') }} as _payload_hash,
    {{ json_text('players.payload', '$.boxScoreTraditional.gameId') }} as game_id,
    {{ json_text('players.payload', '$.boxScoreTraditional.homeTeamId') }} as home_team_id,
    {{ json_text('players.payload', '$.boxScoreTraditional.awayTeamId') }} as away_team_id,
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
        {{ json_text('players.player', '$.statistics.fieldGoalsMade') }} as field_goals_made,
        {{ json_text('players.player', '$.statistics.fieldGoalsAttempted') }} as field_goals_attempted,
        {{ json_text('players.player', '$.statistics.fieldGoalsPercentage') }} as field_goals_percentage,
        {{ json_text('players.player', '$.statistics.threePointersMade') }} as three_pointers_made,
        {{ json_text('players.player', '$.statistics.threePointersAttempted') }} as three_pointers_attempted,
        {{ json_text('players.player', '$.statistics.threePointersPercentage') }} as three_pointers_percentage,
        {{ json_text('players.player', '$.statistics.freeThrowsMade') }} as free_throws_made,
        {{ json_text('players.player', '$.statistics.freeThrowsAttempted') }} as free_throws_attempted,
        {{ json_text('players.player', '$.statistics.freeThrowsPercentage') }} as free_throws_percentage,
        {{ json_text('players.player', '$.statistics.reboundsOffensive') }} as rebounds_offensive,
        {{ json_text('players.player', '$.statistics.reboundsDefensive') }} as rebounds_defensive,
        {{ json_text('players.player', '$.statistics.reboundsTotal') }} as rebounds_total,
        {{ json_text('players.player', '$.statistics.assists') }} as assists,
        {{ json_text('players.player', '$.statistics.steals') }} as steals,
        {{ json_text('players.player', '$.statistics.blocks') }} as blocks,
        {{ json_text('players.player', '$.statistics.turnovers') }} as turnovers,
        {{ json_text('players.player', '$.statistics.foulsPersonal') }} as fouls_personal,
        {{ json_text('players.player', '$.statistics.points') }} as points,
        {{ json_text('players.player', '$.statistics.plusMinusPoints') }} as plus_minus_points
from players
