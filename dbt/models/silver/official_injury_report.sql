{#
  The leagues' official injury reports, typed: one row per player (or team not yet submitted)
  per game per report. A report that landed on more than one day appears once. is_latest marks
  the league's newest report, the one the site reads.

  reason_group sorts the league's reasons: injury (Injury/Illness), g_league (an assignment or
  a two-way player), rest, personal, suspension, not_with_team, or other; injury_detail is the
  reason without its "Injury/Illness - " prefix.
#}

with listed as (

    select *
    from {{ ref('league_injury_report') }}
    where report is not null
    qualify row_number() over (
        partition by league, report, team, coalesce(player_name, '-'), game_date
        order by _ingest_date desc, _source_file desc
    ) = 1

),

typed as (

    select
        league,
        season,
        report,
        cast(replace(substr(published_et, 1, 19), 'T', ' ') as timestamp) as published_at_et,
        make_date(
            cast(substr(game_date, 7, 4) as integer),
            cast(substr(game_date, 1, 2) as integer),
            cast(substr(game_date, 4, 2) as integer)
        ) as game_date,
        game_time_et,
        matchup,
        substr(matchup, 1, instr(matchup, '@') - 1) as away_tricode,
        substr(matchup, instr(matchup, '@') + 1) as home_tricode,
        team,
        player_name,
        player_name_listed,
        status,
        reason,
        case
            when reason like 'Injury/Illness%' then 'injury'
            when reason like 'G League%' then 'g_league'
            when reason like 'Rest%' then 'rest'
            when reason like 'Personal%' then 'personal'
            when lower(reason) like '%suspension%' then 'suspension'
            when reason like 'Not With Team%' then 'not_with_team'
            when reason is null then null
            else 'other'
        end as reason_group,
        case
            when reason like 'Injury/Illness - %' then substr(reason, 18)
            else reason
        end as injury_detail,
        coalesce(lower(not_submitted) = 'true', false) as not_submitted,
        cast(_ingest_date as date) as _ingest_date
    from listed

)

select
    league || ':' || report || ':' || coalesce(team, '-') || ':' || coalesce(player_name, '-') || ':' || cast(game_date as string)
        as official_injury_key,
    *,
    published_at_et = max(published_at_et) over (partition by league) as is_latest
from typed
