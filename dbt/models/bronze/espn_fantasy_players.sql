{{ config(tags=['feed_reports'], partition_by=(['league', 'season'] if target.type == 'databricks' else none)) }}

{# ESPN fantasy's market as landed: one row per player per landing, with how widely ESPN leagues
   roster and start the player, the average draft position and auction value, and ESPN's draft
   ranks. Values stay text until silver. #}

{{ espn_market_rows('fantasy_players') }}
