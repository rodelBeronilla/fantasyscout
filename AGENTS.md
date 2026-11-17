# Working in this repository

Read these first, in this order:

1. [.sdlc/state.md](.sdlc/state.md): what is in flight, what waits on the owner, and the decisions in force, including the merge rule.
2. [.sdlc/pillars.md](.sdlc/pillars.md): the priorities that decide what to work on, who sees what, and the rules for a new signal.
3. [CONTRIBUTING.md](CONTRIBUTING.md): branches, commits, pull requests and the checks a change must pass.

To set up the tools, run `bash tools/dev/setup.sh`, then `source .tools/env.sh` in each new shell. It installs uv, the Python environment, the npm packages and the Playwright browser inside the repository or in each tool's default folder, never in a temporary one, and puts `tools/dev/merge-pr.sh` (merge once the checks pass, then reset `preprod`) on the PATH. It is safe to run again.

Then the plans: the issues they name, `docs/runbook.md` for anything failing, and `docs/adr/` for why things are as they are.

Update `.sdlc/state.md` after anything that changes what is in flight, what waits on the owner, or a decision.
