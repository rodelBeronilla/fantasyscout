{#
  ingest_endpoint_rows(relation): one row per ingest run and endpoint (#398). The run log keeps the
  per-endpoint counts as one JSON object, {"<endpoint>": {"landed": n, "unchanged": n, "failed": n,
  "missing": n}}, in ingest_log.endpoints; this turns its keys into rows. DuckDB lists the keys with
  json_keys; Databricks reads the object as a map and explodes it.
#}

{% macro ingest_endpoint_rows(relation) -%}
  {{ return(adapter.dispatch('ingest_endpoint_rows', 'fantasyscout')(relation)) }}
{%- endmacro %}

{% macro default__ingest_endpoint_rows(relation) -%}
select
    l.run_id,
    l.source,
    l.league,
    l.started_at,
    l.window_since,
    l.window_until,
    l.full_refresh,
    e.endpoint,
    {% for k in ['landed', 'unchanged', 'failed', 'missing'] %}
    coalesce(try_cast(json_extract_string(l.endpoints, '$."' || e.endpoint || '".{{ k }}') as integer), 0) as {{ k }}{{ ',' if not loop.last }}
    {% endfor %}
from {{ relation }} as l
cross join unnest(json_keys(cast(l.endpoints as json))) as e(endpoint)
where l.endpoints is not null
{%- endmacro %}

{% macro databricks__ingest_endpoint_rows(relation) -%}
select
    run_id,
    source,
    league,
    started_at,
    window_since,
    window_until,
    full_refresh,
    endpoint,
    {% for k in ['landed', 'unchanged', 'failed', 'missing'] %}
    coalesce(counts['{{ k }}'], 0) as {{ k }}{{ ',' if not loop.last }}
    {% endfor %}
from (
    select
        run_id, source, league, started_at, window_since, window_until, full_refresh,
        explode(from_json(endpoints, 'map<string,map<string,int>>')) as (endpoint, counts)
    from {{ relation }}
    where endpoints is not null
)
{%- endmacro %}
