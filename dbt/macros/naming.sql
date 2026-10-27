{#
  Layer schemas are named exactly (bronze, silver, gold, ops), not prefixed with the
  profile's default schema. On Databricks every relation lives in the fantasyscout catalog.
#}

{% macro generate_schema_name(custom_schema_name, node) -%}
  {%- if custom_schema_name is none -%}
    {{ target.schema }}
  {%- else -%}
    {{ custom_schema_name | trim }}
  {%- endif -%}
{%- endmacro %}

{% macro generate_database_name(custom_database_name, node) -%}
  {%- if target.type == 'databricks' -%}
    fantasyscout
  {%- elif custom_database_name is none -%}
    {{ target.database }}
  {%- else -%}
    {{ custom_database_name | trim }}
  {%- endif -%}
{%- endmacro %}
