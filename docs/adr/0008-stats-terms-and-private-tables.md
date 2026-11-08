# 0008. The statistics' terms, source credit and the private tables

Date: 2026-10-29
Status: Accepted

## Context

Section 9 of NBA.com's terms covers "NBA Statistics", meaning statistics from NBA, WNBA and G League games served by the stats API we ingest. Under it the statistics:
- may be used only for legitimate news reporting or private, non-commercial purposes;
- must carry a prominent attribution to NBA.com;
- may not be used "in connection with any fantasy game or other commercial product or service";
- may not be used, without consent, by a site that features "a database (in any medium or format) of comprehensive, regularly updated statistics".

FantasyScout is free and non-commercial and publishes derived values (value above replacement, projections, tiers). But it also published the full gold tables as public Parquet behind an in-browser SQL console: every box score, play and shot, refreshed nightly. That is the database the terms describe. Facts are not copyrightable, but the terms are the operator's conditions for using its site and API.

## Options considered

1. **Credit only.** Keep publishing everything and rely on being free and non-commercial.
2. **Credit, and stop publishing the raw tables.** This drops the SQL console.
3. **Credit, and keep the raw tables private to the owner.** The derived surfaces stay public.

## Decision

Option 3, the owner's choice.

- **Credit.** Every page's footer credits NBA.com and WNBA.com for statistics and ESPN for schedules, rosters and injuries. It states that the site is free, non-commercial and unaffiliated with the leagues or ESPN.
- **Private tables.** The Worker serves Parquet under `/data/` only to the owner (`worker/src/owner.ts`). The check runs on the decoded path, so an escaped name cannot get around it.
- **Sign-in with the owner's Yahoo account.** No password exists to manage. The Yahoo app from ADR 0007 provides OAuth sign-in even while its Fantasy API access is pending.
  - Yahoo's token response names the account (`xoauth_yahoo_guid`), and only `OWNER_YAHOO_GUID` (a repository variable; *since 2026-11-02 an Actions secret only, #435*) gets the owner's cookie: HMAC-signed, HttpOnly, Secure, SameSite=Lax, 30 days. No Yahoo token is kept.
  - Any other account is shown its own id, which is how the owner learns theirs the first time.
  - The sign-in shares the app's one registered redirect URI with the league import, and a state cookie marks the owner's sign-ins.
- **CI's reader key.** CI cannot sign in to Yahoo, so it reads with a key derived from the Yahoo client secret it already holds: HMAC-SHA256(secret, "fantasyscout ci reader"). Rotating that secret rotates the key. Without the Yahoo credentials, no one is served.
- **Public surfaces.** The JSON the pages read stays public: board, streamers, player pages, Data Health and the manifest. So do the rendered notebooks, the Tableau extract and the dbt docs.
- **CI.** The notebooks and the Tableau extract read the published build with a reader key that `notebooks/fs.py` adds to DuckDB as an HTTP secret: `FS_READER_KEY`, CI's own key (the `CI_READER_KEY` secret, which the deploy also gives the Worker, and the only bearer key it accepts, #429). The build, export and notebook jobs no longer receive the Yahoo client secret; only the deploy does, to give the Worker its credentials. The deploy copies the Yahoo credentials into the Worker and passes `OWNER_YAHOO_GUID` as a variable.

## Consequences

- The SQL console is the owner's tool, and the public sees a "Sign in with Yahoo" button in its place.
- Private access depends on the Yahoo app existing. If it goes, a stored key could replace the sign-in without changing which data is private.
- Fantasy use remains the open question. The site's purpose is fantasy analysis, which the terms name. It stays free, non-commercial and credited, and publishes analysis rather than the statistics themselves. If the operator objects, the site complies.
- New sources each get their own terms check before they are added (issues #126 to #129), and their credit joins the footer.

## Addendum (2026-10-29): the owner signs in with OpenID

The plain OAuth sign-in returned no account id for this Yahoo app (no `xoauth_yahoo_guid`), so it could not tell the owner from anyone else. The owner's sign-in now always asks Yahoo for the `openid` scope. The account is the OpenID token's subject, or failing that the subject from Yahoo's OpenID user info. The plain sign-in is gone. `OWNER_YAHOO_GUID` may be an Actions secret or a repository variable.

## Addendum (2026-10-30): player prop lines are private model inputs

The owner approved two sources of player prop lines, the line a sportsbook sets on a player's points, rebounds, assists, threes, steals, blocks and turnovers:
- DraftKings' lines through ESPN's core API (`propBets`, provider 100);
- The Odds API (v4), every US bookmaker, under the repository secret `ODDS_API_KEY`.

Three sets of terms bear on them:
- NBA.com's terms forbid using its statistics "in connection with" gambling.
- Disney's terms for ESPN restrict automated collection.
- The Odds API's terms allow storing its data and deriving from it.

The decision keeps the lines out of any public surface and away from anything that looks like betting:
- **Private.** Props land in the volume (`landing/espn/prop_bets`, `landing/odds_api/player_props`), are modelled in `silver.player_props` and `gold.fct_player_prop`, and leave the lakehouse only as that gold table's Parquet, which the Worker serves to the owner alone. They are not in the board's, the streamers' or the schedule's JSON, nor in any player file, and no page shows them.
- **A model input and an analysis aid, nothing more.** The lines are a check on the board's projections and, if a backtest says so, an input to them. The site makes no picks, shows no prices and links to no sportsbook.
- **Aggregates only in public.** The rendered notebook (`06_prop_lines`) and its findings publish aggregates, such as the board's mean absolute error against the line and coverage, never a player's line.
- **Polite collection.** One run each morning and evening, with no retries beyond the shared client's. ESPN gets two scoreboard calls and a page or two per game that has not started. The Odds API gets one odds call per event in the next 36 hours, the credits left are logged, and the run stops calling when one call would overdraw them. Without the key, that source is skipped and the run is not failed.

If any of the three operators objects, the source is dropped and its landed files are deleted.

## Addendum (2026-11-02): crawlers, and what the public dbt docs are built from

- **Crawlers are asked to stay off the private routes.** `robots.txt` disallows `/sql/` (the owner's console) and `/data/` (#355). It is a request to well-behaved crawlers, not access control: the Parquet tables stay private because the Worker serves them only to the owner.
- **The dbt docs at `/docs/` come from the CI fixture sample.** They are one of the public surfaces named in the decision. CI generates them on DuckDB from the fixture sample (#67), and the deploy ships them with the site build CI tested (#312; ADR 0001's addendum of 2026-11-02). The Worker serves them with their own Content-Security-Policy, because the docs app is a single page of inline scripts (#67). The models, tests, lineage and column definitions are the lakehouse project's. The column types are DuckDB's and the row counts are the sample's, so the public docs carry no figures from the lakehouse. #350 added a banner at the top of the page that says so, but the deploy inserts it only when it generates the docs itself, on a manual dispatch. The docs CI hands to the deploy do not carry it, and the live `/docs/` had no banner on 2026-11-02. Beyond the models being the same, the PRs do not say why the docs are built from the sample.

## Addendum (2026-11-07): past seasons' ESPN draft positions

The walk-forward harness judges the preseason board against the market (#751, #769), and the market's draft positions begin with this season's daily landings. ESPN's fantasy API still serves each past NBA season's average draft position on the endpoint the daily ingest reads; past WNBA seasons come back empty. The owner approved landing them under the terms the props addendum already set out for ESPN, whose terms restrict automated collection:

- **One polite pass.** `fs-ingest land espn --history` asks once per season (about eight requests for the NBA since 2018-19), through the Backfill workflow's `market` source, and lands the season under its own endpoint (`landing/espn/fantasy_adp`), never where the board reads today's market (#786).
- **What is kept.** The same trimmed fields as the daily market; the harness reads only the draft position, known from the day before the season's first game. A past season's final ownership is end-of-season knowledge and is not used.
- **What is published.** Aggregates of the backtest only: how often the board beat the market, never a player's draft position.
- **On objection** the source is dropped and its landed files are deleted.

## Addendum (2026-11-07): Basketball-Reference team payrolls

The contract-year study (#772) needs each player's salary by season. No salary source permits automated collection. Sports-Reference's terms ask that its pages not be scraped and that no site be built on data scraped from it; it does welcome use of what its pages show, with credit. Spotrac, Pro Sports Transactions and HoopsHype block automated clients outright. The owner chose to collect Basketball-Reference's team payrolls anyway, on these terms:

- **Slow and identified.** One page per team and season (`/teams/<code>/<year>.html`, which robots.txt allows), at least four seconds apart, inside the site's three-second crawl delay and well under its 20-a-minute bot limit. The User-Agent names FantasyScout and links the Sources page. Thirty requests a season, once (`fs-ingest land bref`, the Backfill workflow's `salaries` source). Only the payroll table is kept.
- **Private.** `gold.fct_player_salary` is an input to the study. No page shows a player's salary; only the study's aggregates are published, with credit to Basketball-Reference on the Sources page.
- **On objection** the source is dropped and its landed files are deleted.
- **No way past a block.** Sites that refuse automated clients (a Cloudflare challenge, Turnstile, a robots.txt that names the client) are not collected from by any automated means, and no challenge is answered on anyone's behalf. Pages the owner saves while browsing them can come in through a manual import instead (#772).


## Addendum (2026-11-08): outlets' RSS feeds

The qualitative-signals epic (#812) reads outlets' and beat writers' published news feeds (#839). The local model extracts claims from each item (ADR 0017, #833). The feeds were chosen by their terms first, on these rules:

- **Allowed.** A feed is kept only when its outlet's terms allow automated reading of the feed for non-commercial use, or the outlet publishes no terms and its robots.txt allows the feed.
- **Not used with AI tools.** A feed whose terms forbid using the content with AI tools ("prompting", "grounding", a "context window") is dropped, however open the feed is, because the items go to the local model.
- **Open.** Nothing behind a login, a paywall or a bot check (Cloudflare, Akamai or Vercel challenges), and nothing that answers a non-browser client with 403.
- **What is kept.** The headline, the link and the publish time. The feed's own summary is kept, cut to 400 characters, only where the terms grant its reuse. The linked articles are never fetched, and no full text is kept (several feeds carry the whole story in `content:encoded` or Atom `content`; the parser reads neither).

**Kept**, each recorded with its terms URL, what is kept and why in `ingest/rss_feeds.toml`:

| Feed | League | Kept | Terms decision |
|---|---|---|---|
| Yahoo Sports NBA (`yahoo-nba`) | NBA | headline | Yahoo's terms, 2(o), license the RSS feeds: the content as provided, unmodified, credited and linked. 2(d)(10) bars building an archive from Yahoo's content, so the summary is not stored. |
| Yahoo Sports WNBA (`yahoo-wnba`) | WNBA | headline | As above. |
| Hoops Rumors (`hoops-rumors`) | NBA | headline | No terms of use are published (the privacy policy is the only legal page), the feed is linked from every page, and robots.txt allows it. Nothing grants reuse of the summary. |
| The IX Sports WNBA newsroom (`theix-wnba`) | WNBA | headline | No terms of use are published (a privacy policy only), and robots.txt allows the feed. |
| Winsidr (`winsidr`) | WNBA | headline | No terms or privacy page are published, and robots.txt allows the feed. |

**Dropped**:

- Terms forbid AI use:
  - ESPN's RSS feeds. Disney's terms bar "prompting … of any artificial intelligence" tool and automated copying. The ESPN headlines are also already landed through ESPN's API (#833 reads them).
  - The SB Nation sites: the league feeds, the team blogs (Pounding The Rock, Liberty Ballers, Silver Screen and Roll, Bright Side of the Sun, CelticsBlog) and Swish Appeal. Penske Media's terms (§19) license the feeds, but bar using content "to train or ground artificial intelligence".
  - The Seattle Times (Storm).
  - Advance Local's papers (cleveland.com Cavaliers, OregonLive Trail Blazers).
  - RotoWire, whose terms also bar automated access.
  - Sporting News, whose terms also bar automated access.
- Terms forbid automated reading and grant no RSS licence:
  - CBS Sports: personal viewing only, and "may not build a business or other enterprise … whether for profit or not".
  - NBC Sports and ProBasketballTalk: no crawler or aggregator.
  - The Las Vegas Review-Journal (Aces).
  - The Deseret News (Jazz).
  - NOLA.com (Pelicans).
- Fox Sports: its feed terms allow non-commercial use, but the feed host's robots.txt disallows everything.
- Blocked, a challenge, or no feed:
  - NBA.com and the team sites: 403 to non-browser clients, no team feeds.
  - WNBA.com: no feed.
  - RealGM: Cloudflare challenge.
  - NY Daily News, Mercury News, Denver Post, OC Register: 403.
  - Star Tribune: Vercel checkpoint.
  - Boston Globe: an empty feed.
  - Salt Lake Tribune: terms unreadable without a browser.
  - The Ringer: no feed.
- Her Hoop Stats (Substack): its posts are mostly about women's college basketball, and Substack's terms bar crawling pages.

No team beat writer's feed passed: every local paper's feed was blocked, challenged or barred by its terms, and the SB Nation team blogs bar AI use. The beat coverage that remains is what the league-wide feeds carry.

**Collection** (`fs-ingest land rss`, and within every `reports` run, so once each morning and at each evening injury-report run):

- One request per feed per run, with no retry.
- A User-Agent that names FantasyScout and links the Sources page.
- `If-None-Match` and `If-Modified-Since` from the feed's last landing, so an unchanged feed costs a 304.
- Redirects are not followed.
- A feed that is down, moved or no longer a feed is recorded as missing and never fails the run.

**Use.** Items are landed privately (`landing/rss/items`). They are modelled in `silver.rss_feed_items` and `gold.fct_player_rss_item`, the second going out only as owner-only Parquet. They are read by the claims extractor as source `rss:<feed_id>`, with the headline's confidence cap. No page shows them, and the Sources page credits each outlet.

**On objection** the feed is removed from `ingest/rss_feeds.toml`, and its landed files and claims are deleted (runbook, "Remove a source on request").

## Addendum (2026-11-08): ESPN content read by the local model

Disney's terms, which cover ESPN, now bar using its content with AI tools ("prompting … of any artificial intelligence", #845). The claims pipeline (#833) has the local model read ESPN headlines and injury notes to pull out dated, sourced claims. The owner chose to continue on the terms this ADR already sets for ESPN and for Basketball-Reference:

- **Private and derived.** The model runs on the home runner and sends nothing outside it. Claims are stored for the walk-forward to score; no page shows them, and none of ESPN's text is published.
- **On objection** ESPN is dropped from the model's inputs, and its claims are deleted.
- **Not extended.** The RSS feeds whose terms bar AI use stay out of the model (the RSS addendum above); the owner's choice covers ESPN only.

