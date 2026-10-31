/**
 * The Pipeline page's diagrams. Counts, seed names and settings come from the generated schema
 * file so the drawings cannot drift from the project; links to other pages go through href().
 *
 * One notation throughout: processes carry the stage numbers of the page's sections (1 to 7),
 * stores are numbered D1 to D6, a solid arrow carries the data it is labelled with, and a dashed
 * arrow is a condition that carries no data. The sequence diagram follows UML instead (dashed
 * arrows are replies), and says so in its caption.
 */
import schema from '../generated/schema.json';
import { DOT_DEFAULTS, renderDot, sequenceSvg, TOKEN as T } from './diagram';
import { href } from './site';

const layers = schema.layers as { name: string; models: { name: string }[] }[];
const count = (layer: string) => layers.find((l) => l.name === layer)?.models.length ?? 0;
const seeds = (schema.seeds as { name: string }[]).map((s) => s.name);
const fantasy = schema.fantasy as {
  fantasy: Record<string, { teams: number; roster_spots: number; prior_games: number; durability_games: number; minutes_recency: number[] }>;
  fantasy_recency: number[];
  fantasy_durability: { typical_share: number };
  fantasy_team_change: number;
  fantasy_recent_minutes: number;
  fantasy_return_ramp: { min_games_missed: number; per_game_missed: number; max_cut: number; games_back: number };
};
const nba = fantasy.fantasy['nba']!;
const wnba = fantasy.fantasy['wnba']!;

/** The six source families, as the first data-flow diagram draws them. */
const SOURCE_FAMILIES = [
  { id: 'stats', name: 'League stats API', host: 'stats.wnba.com · stats.nba.com' },
  { id: 'espn', name: 'ESPN site API', host: 'site.api.espn.com' },
  { id: 'fantasy', name: 'ESPN fantasy API', host: 'lm-api-reads.fantasy.espn.com' },
  { id: 'pdf', name: 'Official injury reports', host: 'PDFs · ak-static.cms.nba.com' },
  { id: 'static', name: 'League static files', host: 'stats.nba.com/js/data' },
  { id: 'sleeper', name: 'Sleeper API', host: 'api.sleeper.app' },
] as const;

const EXT = `shape=box, style="filled,bold", fillcolor="${T.bg}", penwidth=1.6`;
const PROC = `shape=box, style="rounded,filled", fillcolor="${T.accentTint}", color="${T.accent}"`;
const STORE = `shape=cylinder, fillcolor="${T.card}"`;
const LINK = `shape=box, style="rounded,dashed,filled", fillcolor="${T.bg}", fontsize=10`;

/** Pairs of names, one pair per line, for a store label. */
const pairs = (names: string[]) => {
  const out: string[] = [];
  for (let i = 0; i < names.length; i += 2) out.push(names.slice(i, i + 2).join(' · '));
  return out.join('\\n');
};

/** Data-flow diagram 1 of 2: from the sources to the publish gate (stages 1 to 3). */
export function dataFlowCollect(): Promise<string> {
  const src = SOURCE_FAMILIES.map((s) => `src_${s.id} [${EXT}, label="${s.name}\\n${s.host}", URL="#sources"];`).join('\n      ');
  return renderDot(`digraph collect {
    ${DOT_DEFAULTS}
    rankdir=TB; nodesep=0.22; ranksep=0.42; compound=true;
    subgraph cluster_src {
      label="External sources (six families)"; labeljust=l; fontsize=11; style="rounded,dashed"; color="${T.line}";
      ${src}
      { rank=same; src_stats; src_espn; src_fantasy; }
      { rank=same; src_pdf; src_static; src_sleeper; }
      src_stats -> src_pdf [style=invis]; src_espn -> src_static [style=invis]; src_fantasy -> src_sleeper [style=invis];
    }
    p1 [${PROC}, label="1. Ingest\\nfs-ingest land: stats · espn · reports", URL="#ingest"];
    d1 [${STORE}, label="D1 Landing volume\\npayloads · .meta.json · _index.json · run logs", URL="#landing"];
    d2 [${STORE}, label="D2 Seeds (repository)\\n${pairs(seeds)}", URL="${href('/schema/#seeds')}"];
    p2 [${PROC}, label="2. Model\\ndbt build on Databricks", URL="#model"];
    d3 [${STORE}, label="D3 Lakehouse (Delta)\\nbronze ${count('bronze')} · silver ${count('silver')} · gold ${count('gold')} · ops ${count('ops')}", URL="${href('/schema/')}"];
    p3 [${PROC}, label="3. Gate\\nops/results.py", URL="#gate"];
    next [${LINK}, label="continues in diagram 2\\nat 4. Export", URL="#dfd-publish"];

    src_static -> p1 [ltail=cluster_src, label="JSON and PDF over HTTPS"];
    p1 -> d1 [label="payloads, run log\\n(Files API)"];
    d1 -> p2 [label="new files (read_files)"];
    d2 -> p2 [label="seed rows"];
    p2 -> d3 [label="tables"];
    p2 -> p3 [label="run_results.json"];
    p3 -> d3 [label="test_results,\\npublish_gate"];
    p3 -> next [style=dashed, label="gate open"];
    { rank=same; d2; p2; }
    { rank=same; d3; p3; }
  }`);
}

/** Data-flow diagram 2 of 2: from the gate to the reader (stages 4 to 7). */
export function dataFlowPublish(): Promise<string> {
  return renderDot(`digraph publish {
    ${DOT_DEFAULTS}
    rankdir=TB; nodesep=0.3; ranksep=0.42;
    prev [${LINK}, label="from 3. Gate\\nin diagram 1", URL="#dfd-collect"];
    d3 [${STORE}, label="D3 Lakehouse (Delta)\\ngold · ops", URL="${href('/schema/')}"];
    p4 [${PROC}, label="4. Export\\nfs-export build --stage", URL="#export"];
    d4 [${STORE}, label="D4 R2 builds/<id>/\\nParquet · JSON · players · health\\nmanifest · keys.txt", URL="#export"];
    p5 [${PROC}, label="5. Analyse\\nnotebooks · Tableau extract", URL="#analysis"];
    d6 [${STORE}, label="D6 Google Sheet\\none tab per extract file", URL="#analysis"];
    tab [${EXT}, label="Tableau Public\\nworkbook (publish pending)", URL="#analysis"];
    p6 [${PROC}, label="6. Promote\\nfs-export promote", URL="#promote"];
    d5 [${STORE}, label="D5 R2 pointers\\nbuilds.json · latest.json", URL="#promote"];
    p7 [${PROC}, label="7. Serve\\nCloudflare Worker", URL="#serving"];
    yahoo [${EXT}, label="Yahoo\\nOpenID sign-in", URL="#serving"];
    reader [${EXT}, label="Reader\\n(browser)", URL="#serving"];
    owner [${EXT}, label="Site owner\\n(browser, SQL console)", URL="#serving"];

    prev -> p4 [style=dashed, label="gate open"];
    d3 -> p4 [label="gold + ops\\n(SQL API, Arrow)"];
    p4 -> d4 [label="build files"];
    p4 -> p5 [label="build id"];
    d4 -> p5 [label="staged files\\n(HTTPS, CI reader key)"];
    p5 -> d4 [label="notebook pages,\\nfindings, CSVs"];
    p4 -> p6 [label="build id"];
    d4 -> p6 [label="manifest"];
    p6 -> d5 [label="builds.json,\\nthen latest.json"];
    p5 -> d6 [label="extract, after\\npromotion (Sheets API)"];
    d6 -> tab [label="daily refresh"];
    d5 -> p7 [label="pointers"];
    d4 -> p7 [label="build files"];
    p7 -> reader [label="pages, public JSON,\\nnotebook pages"];
    p7 -> owner [label="private Parquet\\n(range requests)"];
    owner -> p7 [label="sign-in"];
    p7 -> yahoo [label="OpenID request"];
    yahoo -> p7 [label="account id"];
    { rank=same; p5; p6; }
    { rank=same; d6; d5; }
  }`);
}

const EXEC = `shape=box3d, fillcolor="${T.card}"`;
const ART = `shape=note, fillcolor="${T.bg}"`;
/** A UML node drawn as a shaded, labelled cluster; what is drawn inside it is deployed on it. */
const node = (id: string, label: string, body: string, fill: string = T.accentTint) =>
  `subgraph cluster_${id} { label="${label}"; labeljust=l; style="rounded,filled"; fillcolor="${fill}"; color="${T.line}"; fontsize=11; ${body} }`;

/** UML deployment diagram 1 of 2: where ingest and the build run (stages 1 to 3). */
export function deploymentCollect(): Promise<string> {
  const host = `shape=box3d, fillcolor="${T.bg}", fontsize=10`;
  return renderDot(`digraph deployCollect {
    ${DOT_DEFAULTS}
    rankdir=LR; nodesep=0.22; ranksep=0.7; newrank=true;
    ${node(
      'home',
      '«device» home server, Docker',
      node('runner', '«execution environment»\\ntwo runner containers', `a_stats [${ART}, label="fs-ingest land stats\\ningest.yml · backfill.yml"];`, T.card),
    )}
    ${node(
      'gh',
      '«cloud» GitHub Actions',
      node(
        'ubuntu',
        '«execution environment»\\nhosted runners, ubuntu-latest',
        `
        a_ingest [${ART}, label="fs-ingest land espn · reports\\ningest.yml · backfill.yml"];
        a_build [${ART}, label="build.yml, dbt job: dbt build,\\ngate, incident (continues\\nin diagram 2)"];
        a_bundle [${ART}, label="build.yml, bundle job:\\ndatabricks bundle deploy"];`,
        T.card,
      ),
    )}
    ${node(
      'ext',
      '«external» source hosts',
      `
      h_stats [${host}, label="stats.wnba.com\\nstats.nba.com"];
      h_espn [${host}, label="site.api.espn.com\\nlm-api-reads.fantasy.espn.com"];
      h_league [${host}, label="ak-static.cms.nba.com\\nofficial.nba.com"];
      h_sleeper [${host}, label="api.sleeper.app"];`,
      T.bg,
    )}
    ${node(
      'dbx',
      '«cloud» Databricks',
      `
      wh [${EXEC}, label="«execution environment»\\nSQL warehouse"];
      job [${ART}, label="dbt job from the bundle\\n(deployed, paused)"];
      vol [shape=cylinder, label="Unity Catalog volume\\nraw/landing"];
      delta [shape=cylinder, label="Delta tables\\nbronze · silver\\ngold · ops"];`,
    )}

    a_stats -> h_stats [label="HTTPS"];
    a_ingest -> h_stats [label="static files"];
    a_ingest -> h_espn [label="HTTPS"];
    a_ingest -> h_league [label="HTTPS"];
    a_ingest -> h_sleeper [label="HTTPS"];
    a_stats -> vol [label="Files API"];
    a_ingest -> vol [label="Files API"];
    a_build -> wh [label="dbt-databricks,\\nSQL API"];
    wh -> vol [label="read_files"];
    wh -> delta [label="SQL"];
    a_bundle -> job [label="Databricks API"];
    { rank=same; h_stats; h_espn; h_league; h_sleeper; wh; job; }
  }`);
}

/** UML deployment diagram 2 of 2: where publishing and serving run (stages 4 to 7). */
export function deploymentPublish(): Promise<string> {
  return renderDot(`digraph deployPublish {
    ${DOT_DEFAULTS}
    rankdir=TB; nodesep=0.25; ranksep=0.55; newrank=true;
    ${node(
      'gh',
      '«cloud» GitHub Actions',
      node(
        'ubuntu',
        '«execution environment»\\nhosted runners, ubuntu-latest',
        `
        a_build [${ART}, label="build.yml, dbt job: export,\\nnotebooks, extract, promote,\\nsheet push"];
        a_web [${ART}, label="deploy-web.yml: site, dbt docs,\\nDuckDB-WASM files, Worker"];`,
        T.card,
      ),
    )}
    ${node(
      'cf',
      '«cloud» Cloudflare',
      `
      wk [${EXEC}, label="«execution environment»\\nWorker, production\\nfantasyscout.beronilla.rodeo"];
      wkp [${EXEC}, label="«execution environment»\\nWorker, preview (preprod)\\nworkers.dev"];
      r2 [shape=cylinder, label="R2 fantasyscout-data\\nbuilds · pointers\\nvendor/duckdb-wasm"];`,
    )}
    ${node('g', '«cloud» Google', `sheet [shape=cylinder, label="Sheet\\nLeague Pulse extract"];`)}
    ${node('t', '«cloud» Tableau Public', `wb [${ART}, label="League Pulse workbook\\n(publish pending)"];`)}
    ${node('y', '«cloud» Yahoo', `oid [${EXEC}, label="OpenID provider\\napi.login.yahoo.com"];`)}
    ${node(
      'b',
      '«device» browser',
      `
      app [${ART}, label="Astro pages\\nReact islands"];
      duck [${ART}, label="DuckDB-WASM\\nSQL console (owner)"];`,
    )}

    a_build -> r2 [label="R2 API"];
    a_build -> wk [label="HTTPS, CI key"];
    a_build -> sheet [label="Sheets API"];
    a_web -> wk [label="wrangler"];
    a_web -> wkp [label="wrangler"];
    a_web -> r2 [label="wrangler r2"];
    wk -> r2 [label="R2 binding"];
    wkp -> r2 [label="R2 binding"];
    wk -> oid [label="OpenID"];
    wb -> sheet [label="reads daily"];
    app -> wk [label="HTTPS"];
    duck -> wk [label="HTTPS range"];
    app -> wb [label="iframe, once published"];
    duck -> app -> a_web -> a_build [style=invis];
    { rank=same; app; duck; a_web; a_build; }
  }`);
}

/** UML sequence diagram of a day: two scheduled runs, each followed by a build. */
export function dailyRun(): string {
  return sequenceSvg(
    [
      { id: 'cron', label: 'Schedule', sub: '09:15 · 23:00 UTC' },
      { id: 'home', label: 'Home runner', sub: 'stats ingest' },
      { id: 'gh', label: 'GitHub runner', sub: 'ESPN, reports' },
      { id: 'src', label: 'Sources', sub: 'six families' },
      { id: 'vol', label: 'Landing', sub: 'UC volume' },
      { id: 'build', label: 'Build job', sub: 'GitHub runner' },
      { id: 'wh', label: 'SQL warehouse', sub: 'Databricks' },
      { id: 'cf', label: 'Cloudflare', sub: 'Worker · R2' },
    ],
    [
      { kind: 'async', from: 'cron', to: 'gh', text: 'start Ingest (plan job)' },
      {
        kind: 'alt',
        text: '09:15 run only',
        steps: [
          { kind: 'call', from: 'gh', to: 'src', text: 'scoreboards, summaries' },
          { kind: 'reply', from: 'src', to: 'gh', text: 'ESPN JSON' },
          { kind: 'call', from: 'gh', to: 'vol', text: 'land payloads + run log' },
          { kind: 'async', from: 'cron', to: 'home', text: 'stats jobs, if the label is set' },
          { kind: 'call', from: 'home', to: 'src', text: 'schedule, logs, box scores, plays' },
          { kind: 'reply', from: 'src', to: 'home', text: 'JSON (paced)' },
          { kind: 'call', from: 'home', to: 'vol', text: 'land payloads + run log' },
        ],
      },
      { kind: 'self', at: 'gh', text: 'reports jobs, in both runs' },
      { kind: 'call', from: 'gh', to: 'src', text: 'six feeds' },
      { kind: 'reply', from: 'src', to: 'gh', text: 'PDF, JSON' },
      { kind: 'call', from: 'gh', to: 'vol', text: 'land parsed, trimmed payloads' },
      { kind: 'note', over: ['home', 'gh'], text: 'a failed job opens its own incident' },
      { kind: 'async', from: 'gh', to: 'build', text: 'Ingest finished (workflow_run)' },
      { kind: 'call', from: 'build', to: 'wh', text: 'dbt build: models + tests' },
      { kind: 'call', from: 'wh', to: 'vol', text: 'read new files' },
      { kind: 'reply', from: 'wh', to: 'build', text: 'run results' },
      { kind: 'self', at: 'build', text: 'gate: record results, decide' },
      {
        kind: 'alt',
        text: 'gate open',
        steps: [
          { kind: 'call', from: 'build', to: 'wh', text: 'read gold + ops (Arrow)' },
          { kind: 'call', from: 'build', to: 'cf', text: 'stage builds/<id>/' },
          { kind: 'call', from: 'build', to: 'cf', text: 'notebooks, extract read it' },
          { kind: 'reply', from: 'cf', to: 'build', text: 'Parquet, JSON (CI key)' },
          { kind: 'call', from: 'build', to: 'cf', text: 'add pages, findings, CSVs' },
          { kind: 'call', from: 'build', to: 'cf', text: 'promote: latest.json last' },
          { kind: 'self', at: 'build', text: 'push the extract to the sheet' },
        ],
      },
      { kind: 'self', at: 'build', text: 'incident: open, update or close' },
      { kind: 'self', at: 'build', text: 'bundle job: deploy the paused job' },
    ],
  );
}

/** UML activity diagram: how a player's board value is computed. */
export function valueActivity(): Promise<string> {
  const act = `shape=box, style="rounded,filled", fillcolor="${T.card}"`;
  const dec = `shape=diamond, fillcolor="${T.warnTint}", fontsize=10, width=1.5, height=0.6`;
  const bar = (w: number) => `shape=box, label="", height=0.05, width=${w}, fillcolor="${T.fg}", color="${T.fg}", fixedsize=true`;
  const pool = (l: { teams: number; roster_spots: number }) => l.teams * l.roster_spots;
  const recent = fantasy.fantasy_recent_minutes;
  const ramp = fantasy.fantasy_return_ramp;
  return renderDot(`digraph value {
    ${DOT_DEFAULTS}
    rankdir=TB; nodesep=0.3; ranksep=0.22;
    start [shape=circle, label="", width=0.22, fillcolor="${T.fg}", color="${T.fg}"];
    a1 [${act}, label="Per-season lines for this season and the two before (mart_category_zscores),\\nfor players on their team's latest roster", URL="${href('/schema/#m-mart_category_zscores')}"];
    fork [${bar(6)}];
    a3 [${act}, label="Production per minute\\nseasons weighted by\\nminutes × ${fantasy.fantasy_recency.join(' / ')}"];
    a4 [${act}, label="Minutes per game\\ngames × ${nba.minutes_recency.join(' / ')} (NBA)\\ngames × ${wnba.minutes_recency.join(' / ')} (WNBA)\\nanother team's season × ${fantasy.fantasy_team_change}\\nin season, 5+ games for the team:\\n${1 - recent} of this, ${recent} of the last five games\\nback from ${ramp.min_games_missed}+ games missed: cut ${+(ramp.per_game_missed * 100).toFixed(2)}% a game\\nmissed (at most ${+(ramp.max_cut * 100).toFixed(2)}%), gone ${ramp.games_back} games back"];
    a5 [${act}, label="Games share\\nregular season, regressed\\nto ${fantasy.fantasy_durability.typical_share} by ${nba.durability_games} (NBA)\\nor ${wnba.durability_games} (WNBA) games"];
    join [${bar(3.6)}];
    a6 [${act}, label="Projected line = rate × minutes, starting from ${nba.prior_games} (NBA) / ${wnba.prior_games} (WNBA)\\ngames of a replacement-level player", URL="${href('/schema/#m-mart_player_projection')}"];
    a7 [${act}, label="Two z-score passes over ${pool(nba)} NBA / ${pool(wnba)} WNBA players:\\nmost projected minutes, then most value"];
    a8 [${act}, label="Subtract replacement level per category (the next ${nba.teams} / ${wnba.teams} players)\\nvalue_per_game = the sum of the nine", URL="${href('/schema/#m-mart_board')}"];
    d1 [${dec}, label="above\\nreplacement?"];
    a9 [${act}, label="value_total =\\nvalue per game × games share"];
    a10 [${act}, label="value_total =\\nvalue per game"];
    d2 [${dec}, label="regular season\\nstill on?"];
    a12 [${act}, label="rest of season = value × remaining share × availability\\n(value above replacement only)\\navailability, from ESPN's listing: out = the games before the\\nreturn date (all without one); doubtful 0.75 of a game,\\nquestionable 0.5, day-to-day 0.25"];
    a13 [${act}, label="rest of season =\\nvalue"];
    stop [shape=doublecircle, label="", width=0.18, fillcolor="${T.fg}", color="${T.fg}"];

    start -> a1 -> fork;
    fork -> a3; fork -> a4; fork -> a5;
    a3 -> join; a4 -> join;
    join -> a6 -> a7 -> a8 -> d1;
    a5 -> a9 [label="games share"];
    d1 -> a9 [label="yes"];
    d1 -> a10 [label="no"];
    a9 -> d2; a10 -> d2;
    d2 -> a12 [label="yes"];
    d2 -> a13 [label="no"];
    a12 -> stop; a13 -> stop;
  }`);
}
