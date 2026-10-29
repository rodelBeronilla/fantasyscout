{#
  Transactions from both sources, one row per move. The NBA's movement feed names the player and
  team by league id (signings, waivers, trades, conversions, waiver claims); ESPN's feed covers
  both leagues as one line per team and day, and is the only one with G League assignments and
  recalls. move_type sorts either by its wording.
#}

with nba as (

    select
        league,
        cast(substr(transaction_date, 1, 10) as date) as transaction_date,
        cast(cast(cast(team_id as double) as bigint) as string) as team_id,
        cast(cast(cast(player_id as double) as bigint) as string) as player_id,
        transaction_type,
        description,
        cast(null as string) as source_team_abbreviation,
        'nba' as source,
        _ingest_date,
        _source_file
    from {{ ref('league_player_movement') }}
    where description is not null

),

espn as (

    select
        e.league,
        cast(substr(e.transaction_at, 1, 10) as date) as transaction_date,
        tx.stats_team_id as team_id,
        cast(null as string) as player_id,
        cast(null as string) as transaction_type,
        e.description,
        e.team_abbreviation as source_team_abbreviation,
        'espn' as source,
        e._ingest_date,
        e._source_file
    from {{ ref('espn_transactions') }} as e
    left join {{ ref('team_xwalk') }} as tx on tx.league = e.league and tx.espn_team_id = e.espn_team_id
    where e.description is not null

),

moves as (

    select * from nba
    union all
    select * from espn

)

select
    league || ':' || source || ':' || cast(transaction_date as string) || ':' || coalesce(team_id, '-') || ':' || coalesce(player_id, '-')
        || ':' || {{ sha256('description') }} as transaction_key,
    league,
    transaction_date,
    team_id,
    player_id,
    transaction_type,
    description,
    case
        when lower(description) like '%g league%' or lower(description) like '%assigned%' then 'g_league'
        when lower(description) like '%recalled%' then 'recall'
        when transaction_type = 'Trade' or lower(description) like '%traded%' or lower(description) like '%acquired%' then 'trade'
        when transaction_type in ('Waive', 'AwardOnWaivers') or lower(description) like '%waived%' or lower(description) like '%released%' then 'waive'
        when transaction_type in ('Signing', 'ContractConverted') or lower(description) like '%signed%' then 'signing'
        when lower(description) like '%suspend%' then 'suspension'
        else 'other'
    end as move_type,
    source_team_abbreviation,
    source
from moves
qualify row_number() over (
    partition by league, source, transaction_date, coalesce(team_id, '-'), coalesce(player_id, '-'), description
    order by _ingest_date desc, _source_file desc
) = 1
