# ai

Phase 7: AI-drafted text under one rule, no number comes from the model (SPEC.md, "AI usage"; ADR 0017).

The weekly scouting notes (`notes.py`, `.github/workflows/notes.yml`):

1. **Inputs** (`inputs.py`, a GitHub runner). The players are picked from the published build's board history without the model: the biggest risers and fallers in rest-of-season value, every change of availability, and minutes shifts beyond 1.5 standard deviations. Each comes with the numbers a note may use, rounded as it should state them, and the row they come from.
2. **Draft** (`client.py`, `prompts/notes.md`, the home runner). The local model (qwen3:8b on Ollama) writes a headline, a body of 60 words at most, and a confidence. It sees the numbers under plain names, and it writes words only.
3. **Validate and publish** (`validate.py`, a GitHub runner):
   - Every number in the text must be one of the input's numbers, at the precision it is written (a share may be written as a percentage). Each such number becomes a claim with its row.
   - The words just before a change must not contradict its sign ("rose" for a fall, "climbed" for a worse rank).
   - A note that fails is not published. It is listed with its reasons in `notes/<league>.json`.
   - The eval drafts notes for earlier snapshots and reports, of every number the drafts wrote, the share that was the build's (`notes/evals.json`).

Locally, with the model reachable at `FS_AI_URL`:

```bash
uv run python -m ai.notes inputs --source local --out inputs.json
uv run python -m ai.notes draft --inputs inputs.json --out draft.json
uv run python -m ai.notes publish --inputs inputs.json --draft draft.json --store local --out _notes
```

The one-line notes on flagged players (`player_notes.py`, `player_note_check.py`, `.github/workflows/player-notes.yml`, #823), daily. All three steps run in one job on the home runner and pass their files on its disk: the inputs and drafts hold source text, which is never uploaded as an artifact. Only the published lines are, when they are published.

1. **Inputs**. From the published build, the players the pages flag: an injury listing (My Team, Today, Pickups) or a flagged ESPN headline, within the ranks a deep league rosters (the same cut as the weekly notes), at most 60 a league. Each comes with its board numbers (rank, rest-of-season value, projected minutes, share of games expected to play, games expected to miss, games this week and left), rounded as a line should write them, and the texts it may draw on, each with its row: the injury note and return date, the flagged headline, the last three days' claims (`fct_player_claim`, exported as owner-only Parquet for this) and the outlets' feed headlines naming him (`fct_player_rss_item`).
2. **Draft** (`prompts/player_notes.md`). The local model writes one line of at most 30 words: what is happening and what to do. When the model is away it drafts nothing.
3. **Check and publish**. A line passes only when every number in it is one of the input's numbers at the precision written (as the weekly notes' validator holds them), or a number one of the texts writes; every quotation in it is a span of a headline, a feed item's title or summary, or a YouTube video's title or description (as the claims' quote check holds a quote), never of a video transcript's speech or an injury note's prose, whose numbers may still inform a line; and it rests on at least one of them. Each becomes a source with its row. The lines that pass go to `notes/players/<league>.json` with the rejections and their reasons, which name numbers and word counts, never a source's words. The pages show a line under a flagged player only for a day after it was written, and only while the player's listing and news flag are the ones it was written on.

```bash
uv run python -m ai.player_notes inputs --source local --out pn-inputs.json
uv run python -m ai.player_notes draft --inputs pn-inputs.json --out pn-draft.json
uv run python -m ai.player_notes publish --inputs pn-inputs.json --draft pn-draft.json --store local
```

The claims from the news (`claims.py`, `.github/workflows/claims.yml`, #833), stored for the backtest and not shown on the site:

The three steps run in one job on the home runner (#861): the inputs hold source text, which never leaves the lakehouse and the owner-only storage, so they pass to the extract on the runner's disk and are never uploaded, and the claims land in the volume only (their quotes are spans of that text). The log carries counts and item ids, never the text.

1. **Inputs** (the home runner). From the published build: the ESPN headlines of the last three days (`fct_player_news`), the ESPN injury notes on the current report (`fct_availability`), and the outlets' feed items of the last three days (`fct_player_rss_item`, #839: the headline, and the feed's summary where its terms allow; source `rss:<feed_id>`). The YouTube channels' items (`fct_player_youtube_item`, #851; source `youtube:<channel>`): a video's title and description, and each 30 seconds of its transcript, which come without their words (a transcript never leaves the lakehouse). Each comes with the league players linked to it: by the crosswalks for ESPN, by the players' whole names for a feed or a video. An item with no linked player is left out.
2. **Extract** (`prompts/claims.md`, `claim_check.py`, the home runner). A transcript chunk's words are read from its landed transcript in the volume first (`landing/youtube/transcripts`); a chunk whose transcript is not there waits for the next run. The local model lists each item's claims: the player, a kind (role, minutes, injury out, return, worse or better, trade rumor, other), a direction, a confidence and the quote. A claim is dropped when its player is not one the item names, its quote is not a span of the item's text, or its direction is not the one its kind states. The same player and kind twice keeps the more confident. The confidence is then capped by rule: a headline (ESPN's or a feed's) at 0.8 and an injury note at 0.9, a YouTube video's title and description at 0.7 and its transcript (spoken analysis, often in automatic captions) at 0.6, a headline naming several players at 0.7, a rumor or "other" at 0.5, a quote under three words at 0.6, a sentence with an expectation ("expected", "probable") at 0.7 and with a hedge ("could", "reportedly") at 0.4.
3. **Land** (the ingest's Landing). Each item's claims, its rejections with their reasons and the text the model read go to `landing/ai/claims/<league>/<season>/<date>/<source>-<id>.json`, with a sidecar. An item already landed is not asked again; when the model is away, the run says so and exits 0.

dbt reads them as `bronze.ai_claims`, `silver.player_claims` and `gold.fct_player_claim`, which a point-in-time build cuts by the day the source said each claim. No number reads them yet: the walk-forward harness (#769) is to score each source's record first (#812). The one-line notes on flagged players read the recent ones as context (above).

```bash
uv run python -m ai.claims inputs --source local --out claim-inputs.json
uv run python -m ai.claims extract --inputs claim-inputs.json --backend local --root .
```
