{{ config(partition_by=(['league', 'season'] if target.type == 'databricks' else none)) }}

{# Raw stats `scheduleleaguev2` payloads parsed to rows; values stay text until silver.  #}

with files as (

    select *
    from ({{ landing_files('stats', 'scheduleleaguev2') }}) as landed
    {{ bronze_incremental_filter() }}

),

game_dates as (

    select
        files.*,
        {{ json_rows('files.payload', '$.leagueSchedule.gameDates') }} as game_date
    from files

),

games as (

    select
        game_dates.*,
        {{ json_rows('game_dates.game_date', '$.games') }} as game
    from game_dates

)

select
    games._source_file,
    games.league,
    games.season,
    games._ingest_date,
    games.request_key,
    {{ sha256('games.payload') }} as _payload_hash,
    {{ json_text('games.payload', '$.leagueSchedule.seasonYear') }} as season_year,
    {{ json_text('games.game_date', '$.gameDate') }} as game_date,
    {{ json_text('games.game', '$.gameId') }} as game_id,
    {{ json_text('games.game', '$.gameCode') }} as game_code,
    {{ json_text('games.game', '$.gameStatus') }} as game_status,
    {{ json_text('games.game', '$.gameStatusText') }} as game_status_text,
    {{ json_text('games.game', '$.gameSequence') }} as game_sequence,
    {{ json_text('games.game', '$.gameDateEst') }} as game_date_est,
    {{ json_text('games.game', '$.gameTimeEst') }} as game_time_est,
    {{ json_text('games.game', '$.gameDateTimeEst') }} as game_date_time_est,
    {{ json_text('games.game', '$.gameDateUTC') }} as game_date_utc,
    {{ json_text('games.game', '$.gameTimeUTC') }} as game_time_utc,
    {{ json_text('games.game', '$.gameDateTimeUTC') }} as game_date_time_utc,
    {{ json_text('games.game', '$.day') }} as day,
    {{ json_text('games.game', '$.monthNum') }} as month_num,
    {{ json_text('games.game', '$.weekNumber') }} as week_number,
    {{ json_text('games.game', '$.weekName') }} as week_name,
    {{ json_text('games.game', '$.ifNecessary') }} as if_necessary,
    {{ json_text('games.game', '$.seriesGameNumber') }} as series_game_number,
    {{ json_text('games.game', '$.gameLabel') }} as game_label,
    {{ json_text('games.game', '$.gameSubLabel') }} as game_sub_label,
    {{ json_text('games.game', '$.seriesText') }} as series_text,
    {{ json_text('games.game', '$.arenaName') }} as arena_name,
    {{ json_text('games.game', '$.arenaState') }} as arena_state,
    {{ json_text('games.game', '$.arenaCity') }} as arena_city,
    {{ json_text('games.game', '$.postponedStatus') }} as postponed_status,
    {{ json_text('games.game', '$.gameSubtype') }} as game_subtype,
    {{ json_text('games.game', '$.isNeutral') }} as is_neutral,
    {{ json_text('games.game', '$.homeTeam.teamId') }} as home_team_id,
    {{ json_text('games.game', '$.homeTeam.teamName') }} as home_team_name,
    {{ json_text('games.game', '$.homeTeam.teamCity') }} as home_team_city,
    {{ json_text('games.game', '$.homeTeam.teamTricode') }} as home_team_tricode,
    {{ json_text('games.game', '$.homeTeam.teamSlug') }} as home_team_slug,
    {{ json_text('games.game', '$.homeTeam.wins') }} as home_wins,
    {{ json_text('games.game', '$.homeTeam.losses') }} as home_losses,
    {{ json_text('games.game', '$.homeTeam.score') }} as home_score,
    {{ json_text('games.game', '$.homeTeam.seed') }} as home_seed,
    {{ json_text('games.game', '$.awayTeam.teamId') }} as away_team_id,
    {{ json_text('games.game', '$.awayTeam.teamName') }} as away_team_name,
    {{ json_text('games.game', '$.awayTeam.teamCity') }} as away_team_city,
    {{ json_text('games.game', '$.awayTeam.teamTricode') }} as away_team_tricode,
    {{ json_text('games.game', '$.awayTeam.teamSlug') }} as away_team_slug,
    {{ json_text('games.game', '$.awayTeam.wins') }} as away_wins,
    {{ json_text('games.game', '$.awayTeam.losses') }} as away_losses,
    {{ json_text('games.game', '$.awayTeam.score') }} as away_score,
    {{ json_text('games.game', '$.awayTeam.seed') }} as away_seed
from games
