{#
  Per-league, per-season, per-window category values for the nine categories (#767, ADR 0019).

  Each window's regular-season per-game line (int_player_window_lines: the season, the last
  twenty and the last ten games) is scored on the season's value scale (int_value_scale): the
  same pool, means, spreads and replacement level for every window, the board's for the season
  it values. So z_total is value per game above the league's replacement level whichever the
  window, and a player's last ten games compare directly with their season and their projection.
  Counting categories are (per game - pool mean) / pool sd, turnovers negative; percentages are
  makes above the pool's percentage on the attempts, over the pool's spread of that impact.
#}

select
    {{ sk(['l.window_name', 'l.league', 'l.season', 'l.player_id']) }} as zscore_sk,
    l.window_name,
    l.league,
    l.season,
    l.player_id,
    l.games,
    l.minutes_pg,
    {%- for c in value_counting() %}
    l.{{ c }}_pg,
    {%- endfor %}
    l.field_goal_pct,
    l.free_throw_pct,
    l.fga_pg,
    l.fta_pg,
    {{ scale_z_columns(pg_stat('l'), 's') }},
    {{ scale_total(pg_stat('l'), 's') }} as z_total
from {{ ref('int_player_window_lines') }} as l
join {{ ref('int_value_scale') }} as s on s.league = l.league and s.season = l.season
