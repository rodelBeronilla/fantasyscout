# 0013. Where the dbt build runs

Date: 2026-11-02
Status: Accepted
Supersedes: the orchestration row of the original brief (SPEC.md, "Databricks Jobs via Asset Bundles for transforms") and the matching row in docs/architecture.md

## Context

The brief put the transforms on Databricks Jobs deployed as an Asset Bundle, with GitHub Actions only for the ingest. Phase 2 built both: `bundles/databricks.yml` declares a scheduled job that runs the same dbt project inside the workspace, and `build.yml` runs `dbt build` on a GitHub-hosted runner after every completed ingest. The job was deployed paused ("unpause once the GitHub Actions build and this job agree") and never unpaused. Since then every build the site has served came from Actions: the build is triggered by the ingest's completion rather than by a clock, its gate, export, notebooks, extract and promotion run in the same job, its outcome and timings go to `ops.build_log`, and its failures open incidents. The bundle deploy ran after every build as a trailing job; on 2026-11-02 that job hung at checkout for over an hour on a GitHub-hosted runner, past its time limit, holding a run open after the data had been promoted (#469).

## Options

**A. Databricks Job, as the brief said.** The workspace runs dbt on its own clock. It cannot see the ingest finish (the ingest runs on GitHub and the home runners), so the job would run on a schedule and either miss a late landing or wait for a margin; the gate, export and promotion would have to move into the workspace or be triggered from it; Free Edition's compute quota would carry the build; incidents, timings and the chaos drill would need a second path.

**B. GitHub Actions, as built.** One job from ingest completion to promotion, with the warehouse doing the SQL. The cost is GitHub minutes (free on a public repository) and a dependence on Actions being up, which the ingest already has.

**C. Both, with the bundle as the fallback.** Keep the job deployed and paused so an operator can run the dbt part inside the workspace if Actions is down. The deploy must then not sit on the critical path of every build.

## Decision

Option B, with C's fallback kept deliberately cheap: the Asset Bundle stays in the repository and deployed paused, but its deploy job runs only on a manual dispatch of the Build workflow (`inputs.deploy_bundle`), never after a nightly build. Running the bundle's job by hand is documented in `bundles/README.md`; it builds the dbt models only (no gate, no export), so it is a way to refresh the lakehouse tables during an Actions outage, not a way to publish.

## Consequences

- `docs/architecture.md` and `SPEC.md` say transforms run in GitHub Actions; the bundle is the fallback.
- A nightly build ends when its data job ends; the trailing deploy that could hold a run open is gone from the daily path.
- Whether to delete the bundle altogether is a later decision: it costs nothing while paused and gives the operator one more way back after an Actions outage, which has not yet happened.
