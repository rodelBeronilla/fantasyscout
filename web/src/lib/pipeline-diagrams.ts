/**
 * The Pipeline page's diagrams. Counts and settings come from the generated schema file so
 * the drawings cannot drift from the project.
 */
import schema from '../generated/schema.json';
import { DOT_DEFAULTS, renderDot, sequenceSvg, TOKEN as T } from './diagram';

const count = (layer: string) => schema.layers.find((l) => l.name === layer)?.models.length ?? 0;
const fantasy = schema.fantasy as {
  fantasy: Record<string, { teams: number; roster_spots: number; prior_games: number; durability_games: number; minutes_recency: number[] }>;
  fantasy_recency: number[];
  fantasy_durability: { typical_share: number };
  fantasy_team_change: number;
};
const nba = fantasy.fantasy['nba']!;
const wnba = fantasy.fantasy['wnba']!;

/** Data-flow diagram: external entities (boxes), processes (rounded), data stores (cylinders). */
export function dataFlow(): Promise<string> {
  const ext = `shape=box, style="filled,bold", fillcolor="${T.bg}", penwidth=1.6`;
  const proc = `shape=box, style="rounded,filled", fillcolor="${T.accentTint}", color="${T.accent}"`;
  const store = `shape=cylinder, fillcolor="${T.card}"`;
  return renderDot(`digraph dfd {
    ${DOT_DEFAULTS}
    rankdir=TB; nodesep=0.3; ranksep=0.5;
    stats [${ext}, label="League stats API\\nstats.wnba.com · stats.nba.com", URL="#sources"];
    espn  [${ext}, label="ESPN site API\\nsite.api.espn.com", URL="#sources"];
    user  [${ext}, label="Fantasy manager\\n(browser)", URL="#serving"];
    tabp  [${ext}, label="Tableau Public", URL="#analysis"];

    p1 [${proc}, label="1. Ingest stats\\nhome runners · paced client", URL="#ingest"];
    p2 [${proc}, label="2. Ingest ESPN\\nGitHub runners · paced client", URL="#ingest"];
    p3 [${proc}, label="3. Model\\ndbt build on Databricks", URL="#bronze"];
    p4 [${proc}, label="4. Decide the gate\\nops/results.py", URL="#gate"];
    p5 [${proc}, label="5. Export\\nfs-export build", URL="#export"];
    p6 [${proc}, label="6. Analyse\\nnotebooks · Tableau extract", URL="#analysis"];
    p7 [${proc}, label="7. Serve\\nCloudflare Worker", URL="#serving"];
    p8 [${proc}, label="8. Query in the browser\\nDuckDB-WASM", URL="#serving"];

    d1 [${store}, label="D1 Landing volume\\nraw JSON · .meta · _index · run log", URL="#landing"];
    d2 [${store}, label="D2 Lakehouse (Delta)\\nbronze ${count('bronze')} · silver ${count('silver')} · gold ${count('gold')} · ops ${count('ops')}", URL="/schema/"];
    d3 [${store}, label="D3 Seeds (repository)\\noverrides · team reference · categories", URL="/schema/#seeds"];
    d4 [${store}, label="D4 R2 builds/<id>/\\nParquet · JSON · players · health · manifest", URL="#export"];
    d5 [${store}, label="D5 R2 pointers\\nlatest.json · builds.json", URL="#export"];
    d6 [${store}, label="D6 Google Sheet\\nthree extract tabs", URL="#analysis"];

    stats -> p1 [label="JSON over HTTPS"];
    espn  -> p2 [label="JSON over HTTPS"];
    p1 -> d1 [label="payloads, run log\\n(Files API)"];
    p2 -> d1 [label="payloads, run log"];
    d1 -> p3 [label="new files\\n(read_files, incremental)"];
    d3 -> p3 [label="seeds"];
    p3 -> d2 [label="tables"];
    p3 -> p4 [label="run_results.json"];
    p4 -> d2 [label="test_results,\\npublish_gate"];
    p4 -> p5 [label="gate open", style=dashed];
    d2 -> p5 [label="gold + ops\\n(SQL API, Arrow)"];
    p5 -> d4 [label="build files"];
    p5 -> d5 [label="pointer, flipped once\\nthe build is complete"];
    d5 -> p7; d4 -> p7;
    p7 -> p6 [label="published build\\n(HTTPS)"];
    p6 -> d4 [label="notebook pages,\\nextract CSVs"];
    p6 -> d6 [label="extract (Sheets API)"];
    d6 -> tabp [label="refresh, about daily"];
    p7 -> user [label="pages, JSON, Parquet"];
    p7 -> p8 [label="Parquet (range requests)"];
    p8 -> user [label="query results"];
    tabp -> user [label="embedded workbook", style=dashed];
    { rank=same; stats; espn; }
    { rank=same; p1; p2; }
    { rank=same; user; tabp; }
  }`);
}

/** UML deployment diagram: execution environments (clusters) and what runs on each. */
export function deployment(): Promise<string> {
  const node = `shape=box3d, fillcolor="${T.card}"`;
  const art = `shape=note, fillcolor="${T.bg}"`;
  const cluster = (id: string, label: string, body: string) =>
    `subgraph cluster_${id} { label="${label}"; labeljust=l; style="rounded,filled"; fillcolor="${T.accentTint}"; color="${T.line}"; fontsize=11; ${body} }`;
  return renderDot(`digraph deploy {
    ${DOT_DEFAULTS}
    rankdir=LR; nodesep=0.3; ranksep=0.7; compound=true;
    stats [shape=box, style="filled,bold", fillcolor="${T.bg}", label="«external»\\nLeague stats API"];
    espn  [shape=box, style="filled,bold", fillcolor="${T.bg}", label="«external»\\nESPN site API"];
    ${cluster('home', '«device» Home server · Docker', `
      runner [${node}, label="«execution environment»\\nrunner containers ×2\\n(label: home)"];
      a_stats [${art}, label="fs-ingest land stats\\n(ingest.yml, backfill.yml)"];
      runner -> a_stats [arrowhead=none, style=dotted];`)}
    ${cluster('gh', '«cloud» GitHub Actions · hosted runners', `
      gh_r [${node}, label="«execution environment»\\nubuntu-latest"];
      a_espn [${art}, label="fs-ingest land espn"];
      a_build [${art}, label="build.yml: dbt build, gate,\\nexport, notebooks, extract,\\nsheet push, incident"];
      a_ops [${art}, label="ci.yml · deploy-web.yml\\nexport.yml · query.yml · probe.yml"];
      gh_r -> a_espn [arrowhead=none, style=dotted];
      gh_r -> a_build [arrowhead=none, style=dotted];
      gh_r -> a_ops [arrowhead=none, style=dotted];`)}
    ${cluster('dbx', '«cloud» Databricks', `
      vol [shape=cylinder, label="Unity Catalog volume\\nraw/landing"];
      wh [${node}, label="«execution environment»\\nSQL warehouse"];
      delta [shape=cylinder, label="Delta tables\\nbronze · silver · gold · ops"];
      job [${art}, label="Asset Bundle job\\n(deployed, paused)"];`)}
    ${cluster('cf', '«cloud» Cloudflare', `
      r2 [shape=cylinder, label="R2 fantasyscout-data\\nbuilds · pointers · vendor"];
      wk [${node}, label="«execution environment»\\nWorker: production\\nfantasyscout.beronilla.rodeo"];
      wkp [${node}, label="«execution environment»\\nWorker: preview (preprod)\\nworkers.dev"];`)}
    ${cluster('g', '«cloud» Google', `sheet [shape=cylinder, label="Sheet\\nLeague Pulse extract"];`)}
    ${cluster('t', '«cloud» Tableau Public', `wb [${art}, label="League Pulse workbook"];`)}
    ${cluster('b', '«device» Browser', `
      app [${art}, label="Astro pages\\nReact islands"];
      duck [${art}, label="DuckDB-WASM\\nSQL console"];`)}

    a_stats -> stats [label="HTTPS"];
    a_espn -> espn [label="HTTPS"];
    a_stats -> vol [label="Files API"];
    a_espn -> vol [label="Files API"];
    a_build -> wh [label="dbt-databricks,\\nSQL Statement API"];
    wh -> vol [label="read_files"];
    wh -> delta;
    a_build -> r2 [label="Cloudflare API"];
    a_build -> sheet [label="Sheets API"];
    a_ops -> wk [label="wrangler deploy"];
    a_ops -> wkp [label="wrangler deploy\\n(preprod)"];
    wk -> r2 [label="R2 binding"];
    wkp -> r2 [label="R2 binding"];
    sheet -> wb [label="refresh"];
    app -> wk [label="HTTPS"];
    duck -> wk [label="HTTPS range"];
    app -> wb [label="iframe", style=dashed];
  }`);
}

/** UML sequence diagram of one daily run, from the schedule to a reader's browser. */
export function dailyRun(): string {
  return sequenceSvg(
    [
      { id: 'cron', label: 'Schedule', sub: '09:15 UTC' },
      { id: 'home', label: 'Home runner', sub: 'stats ingest' },
      { id: 'gh', label: 'GitHub runner', sub: 'ESPN ingest' },
      { id: 'src', label: 'Source APIs', sub: 'stats · ESPN' },
      { id: 'vol', label: 'Landing', sub: 'UC volume' },
      { id: 'build', label: 'Build job', sub: 'GitHub runner' },
      { id: 'wh', label: 'SQL warehouse', sub: 'Databricks' },
      { id: 'r2', label: 'R2', sub: 'Cloudflare' },
      { id: 'web', label: 'Worker + browser', sub: 'readers' },
    ],
    [
      { kind: 'async', from: 'cron', to: 'gh', text: 'start Ingest: plan + ESPN jobs' },
      { kind: 'async', from: 'cron', to: 'home', text: 'stats jobs (if the runner label is set)' },
      { kind: 'call', from: 'gh', to: 'src', text: 'scoreboard, summaries, rosters, injuries' },
      { kind: 'reply', from: 'src', to: 'gh', text: 'JSON' },
      { kind: 'call', from: 'home', to: 'src', text: 'schedule, logs, box scores, pbp, shots' },
      { kind: 'reply', from: 'src', to: 'home', text: 'JSON (paced, cookies dropped)' },
      { kind: 'call', from: 'gh', to: 'vol', text: 'land payloads + run log' },
      { kind: 'call', from: 'home', to: 'vol', text: 'land payloads + run log' },
      { kind: 'note', over: ['home', 'gh'], text: 'a failed job opens its own incident' },
      { kind: 'async', from: 'gh', to: 'build', text: 'Ingest finished (workflow_run)' },
      { kind: 'call', from: 'build', to: 'wh', text: 'ensure dirs; dbt build (models + tests)' },
      { kind: 'call', from: 'wh', to: 'vol', text: 'read new files' },
      { kind: 'reply', from: 'wh', to: 'build', text: 'run results' },
      { kind: 'self', at: 'build', text: 'gate: record results, decide' },
      {
        kind: 'alt',
        text: 'gate open',
        steps: [
          { kind: 'call', from: 'build', to: 'wh', text: 'read gold + ops (Arrow)' },
          { kind: 'call', from: 'build', to: 'r2', text: 'stage: files, manifest' },
          { kind: 'call', from: 'build', to: 'web', text: 'notebooks + extract read it by id' },
          { kind: 'call', from: 'build', to: 'r2', text: 'notebook pages, extract CSVs' },
          { kind: 'call', from: 'build', to: 'r2', text: 'promote: builds.json, latest.json (last)' },
        ],
      },
      { kind: 'self', at: 'build', text: 'incident: names any failed step' },
      { kind: 'call', from: 'web', to: 'r2', text: 'latest.json (60 s cache), build files' },
    ],
  );
}

/** UML activity diagram: how a player's board value is computed. */
export function valueActivity(): Promise<string> {
  const act = `shape=box, style="rounded,filled", fillcolor="${T.card}"`;
  const dec = `shape=diamond, fillcolor="${T.warnTint}", fontsize=10, width=1.6, height=0.7`;
  return renderDot(`digraph value {
    ${DOT_DEFAULTS}
    rankdir=TB; nodesep=0.4; ranksep=0.32;
    start [shape=circle, label="", width=0.22, fillcolor="${T.fg}", color="${T.fg}"];
    a1 [${act}, label="Per-season lines for this season and the two before\\n(mart_category_zscores)", URL="/schema/#m-mart_category_zscores"];
    a2 [${act}, label="Keep players on their team's latest roster landing"];
    a3 [${act}, label="Production per minute\\nseasons weighted by minutes × ${fantasy.fantasy_recency.join(' / ')}"];
    a4 [${act}, label="Minutes per game\\ngames × ${nba.minutes_recency.join(' / ')} (NBA), × ${wnba.minutes_recency.join(' / ')} (WNBA)\\na past season on another team × ${fantasy.fantasy_team_change}"];
    a5 [${act}, label="Games share (regular season)\\nregressed to ${fantasy.fantasy_durability.typical_share} by ${nba.durability_games} (NBA) / ${wnba.durability_games} (WNBA) games"];
    a6 [${act}, label="Add ${nba.prior_games} (NBA) / ${wnba.prior_games} (WNBA) games of a replacement-level player\\nper-game line = rate × minutes", URL="/schema/#m-mart_player_projection"];
    a7 [${act}, label="Pass 1: z-scores over the ${nba.teams * nba.roster_spots} NBA / ${wnba.teams * wnba.roster_spots} WNBA players with most projected minutes"];
    a8 [${act}, label="Pass 2: z-scores over the players pass 1 values most\\npercentages volume-weighted, turnovers negative"];
    a9 [${act}, label="Subtract replacement level per category\\n(the next ${nba.teams} NBA / ${wnba.teams} WNBA players)", URL="/schema/#m-mart_board"];
    a10 [${act}, label="value_per_game = Σ nine categories"];
    d1 [${dec}, label="above\\nreplacement?"];
    a11 [${act}, label="value_total = value per game × games share"];
    a12 [${act}, label="value_total = value per game\\n(unscaled)"];
    d2 [${dec}, label="regular season\\nstill on?"];
    a13 [${act}, label="rest of season = value × remaining share × availability\\n(value above replacement only; injury report)"];
    a14 [${act}, label="rest of season = value"];
    stop [shape=doublecircle, label="", width=0.18, fillcolor="${T.fg}", color="${T.fg}"];
    fork [shape=box, label="", height=0.05, width=5, fillcolor="${T.fg}", color="${T.fg}", fixedsize=true];
    join [shape=box, label="", height=0.05, width=4, fillcolor="${T.fg}", color="${T.fg}", fixedsize=true];
    start -> a1 -> a2 -> fork;
    fork -> a3; fork -> a4; fork -> a5;
    a3 -> join; a4 -> join; join -> a6;
    a5 -> a11 [style=dashed, label="games share"];
    a6 -> a7 -> a8 -> a9 -> a10 -> d1;
    d1 -> a11 [label="yes"]; d1 -> a12 [label="no"];
    a11 -> d2; a12 -> d2;
    d2 -> a13 [label="yes"]; d2 -> a14 [label="no"];
    a13 -> stop; a14 -> stop;
  }`);
}
