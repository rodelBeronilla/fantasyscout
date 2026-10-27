{{ config(severity='error', tags=['chaos']) }}

-- The chaos switch: `--vars '{chaos: true}'` makes this error-severity check fail on purpose,
-- so the publish gate and the incident path can be exercised end to end on demand.
{% if var('chaos', false) %}
select 'deliberate failure requested with the chaos var' as reason
{% else %}
select 'never' as reason where 1 = 0
{% endif %}
