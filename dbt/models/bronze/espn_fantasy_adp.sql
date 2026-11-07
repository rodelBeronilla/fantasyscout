{{ config(partition_by=(['league', 'season'] if target.type == 'databricks' else none)) }}

{# A past season's ESPN fantasy market as landed once by a history run (#786): one row per player,
   with the season's average draft position. The preseason market baseline of the walk-forward
   harness; never the board's market. Values stay text until silver. #}

{{ espn_market_rows('fantasy_adp') }}
