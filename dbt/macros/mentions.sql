{#
  Finding a player's name in a headline (silver rss_items, gold fct_player_rss_item).

  mention_words(col): the text as lowercase ASCII words separated by single spaces, accents folded
  and every other character a separator, with a space at each end. "D'Angelo Russell" and
  "D’Angelo Russell" both read " d angelo russell ", so a name is found by looking for its own
  words, whole, in the text's: "Jalen Green" is not found in "Jalen Greene".

  name_words(col): a player's name the same way, without the generational suffix ("Jaren Jackson
  Jr." reads " jaren jackson "), so a headline that drops the suffix still names him.
#}

{% macro _fold_accents(col) -%}
  translate(lower({{ col }}), 'áàâäãåāăąéèêëēėęěíìîïīįıóòôöõøōőúùûüūůűųñńňçćčýÿśšşźżžđďłľĺŕřťğ', 'aaaaaaaaaeeeeeeeeiiiiiiioooooooouuuuuuuunnncccyyssszzzddlllrrtg')
{%- endmacro %}

{% macro mention_words(col) -%}
  {{ return(adapter.dispatch('mention_words', 'fantasyscout')(col)) }}
{%- endmacro %}

{% macro default__mention_words(col) -%}
  (' ' || trim(regexp_replace({{ _fold_accents(col) }}, '[^a-z0-9]+', ' ', 'g')) || ' ')
{%- endmacro %}

{% macro databricks__mention_words(col) -%}
  (' ' || trim(regexp_replace({{ _fold_accents(col) }}, '[^a-z0-9]+', ' ')) || ' ')
{%- endmacro %}

{% macro name_words(col) -%}
  {{ return(adapter.dispatch('name_words', 'fantasyscout')(col)) }}
{%- endmacro %}

{% macro default__name_words(col) -%}
  regexp_replace({{ mention_words(col) }}, ' (jr|sr|ii|iii|iv) $', ' ')
{%- endmacro %}

{% macro databricks__name_words(col) -%}
  regexp_replace({{ mention_words(col) }}, ' (jr|sr|ii|iii|iv) $', ' ')
{%- endmacro %}
