# FantasyScout: pillar profile

Agreed by the owner on 2026-11-16. Where this file and an older plan disagree, this file wins. The current state and the decisions behind it are in [state.md](state.md).

**Tier:** a personal tool on the public internet.

- A saved league setup may hold other people's team names. It is stored privately per account and deleted on request (ADR 0016).
- The system takes no action in any fantasy league: it reads, and the manager acts.
- The only things it deletes are its own published builds, which can be rebuilt from the landing zone, and the data a signed-in manager asks it to delete.

**Purpose:** the first place the owner looks to run his Yahoo head-to-head nine-category team and to read his eight-team league, with evidence that in-market tools do not give. The platform behind it is public proof of how it was built.

**Non-goals:**

- matching every paid tool's feature list;
- formats the owner does not play, ahead of his own;
- a model nobody can explain;
- a call shown to the public before it passes its bar.

## Priorities, in order

A higher one always wins.

1. Fresh, correct data.
2. Right for the owner's league and team.
3. Evidence at the manager's grain: per category, per week.
4. New signals from data already held.
5. Breadth: other platforms, formats and leagues.

## Who sees what

- **Facts, and arithmetic on facts:** everyone.
- **Calls that passed their bar:** everyone.
- **Calls unjudged or failed:** the signed-in owner only, logged. This is designed in step 3 of the 2026-11-16 plan. Until it ships, these calls are hidden from everyone (`web/src/lib/visibility.ts`).

## Outcome measures

Reviewed every Monday.

- **Days in the week the owner opened the app and acted on something in it.** Not measured yet: the site keeps no analytics beyond Cloudflare's aggregate counts. It needs the owner log from step 3.
- **The graded record:** each call against what happened, beside the naive manager. Not built yet.
- **Hours since the last published build.** The limit is 30 in season and 72 out of season (the watchdog's).

## Rules for a new signal

- **Written before the run:** the hypothesis, the basketball reason, the target category and the bar.
- **Fitted and judged:** fitted on the tuning seasons, judged once on the judged seasons, and confirmed on 2026-27's weeks before it is called validated.
  - The judged seasons (NBA 2023-24 and 2024-25, WNBA 2024 and 2025) have already been used once by every number fitted so far. A judgement on them is evidence, not proof. That is why the 2026-27 confirmation is required.
  - The locked seasons (NBA 2025-26, WNBA 2026) are kept for one final judgement and are not used for a new signal.
- **A short declared list per study.** No sweeping every column against every category.

## Working rules

- **Merge:** as recorded in [state.md](state.md) on 2026-11-16.
- **Delegation:** subagents only for an item with a written bar, two at a time at most. Page design stays in the main chat.
- **Cost:** free tiers and the home machine. Anything paid is the owner's decision.
