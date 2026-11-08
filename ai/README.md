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

The claims from the news (`claims.py`, `.github/workflows/claims.yml`, #833), stored for the backtest and not shown on the site:

1. **Inputs** (a GitHub runner). From the published build: the ESPN headlines of the last three days (`fct_player_news`) and the ESPN injury notes on the current report (`fct_availability`), each with the league players the crosswalks linked it to. An item with no linked player is left out.
2. **Extract** (`prompts/claims.md`, `claim_check.py`, the home runner). The local model lists each item's claims: the player, a kind (role, minutes, injury out, return, worse or better, trade rumor, other), a direction, a confidence and the quote. A claim is dropped when its player is not one the item names, its quote is not a span of the item's text, or its direction is not the one its kind states. The same player and kind twice keeps the more confident. The confidence is then capped by rule: a headline at 0.8 and an injury note at 0.9, a headline naming several players at 0.7, a rumor or "other" at 0.5, a quote under three words at 0.6, a sentence with an expectation ("expected", "probable") at 0.7 and with a hedge ("could", "reportedly") at 0.4.
3. **Land** (the ingest's Landing). Each item's claims, its rejections with their reasons and the text the model read go to `landing/ai/claims/<league>/<season>/<date>/<source>-<id>.json`, with a sidecar. An item already landed is not asked again; when the model is away, the run says so and exits 0.

dbt reads them as `bronze.ai_claims`, `silver.player_claims` and `gold.fct_player_claim`, which a point-in-time build cuts by the day the source said each claim. No number reads them yet: the walk-forward harness (#769) is to score each source's record first (#812).

```bash
uv run python -m ai.claims inputs --source local --out claim-inputs.json
uv run python -m ai.claims extract --inputs claim-inputs.json --backend local --root .
```
