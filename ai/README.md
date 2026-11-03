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
