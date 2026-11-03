# 0017. A local language model for phase 7

Date: 2026-11-03
Status: Accepted

## Context

Phase 7 (SPEC.md, "AI usage") adds AI-drafted text under one rule: no number on the site comes from a language model. The model writes words about numbers the pipeline already computed, and a validator re-checks every claim. The spec named a paid hosted API. The home server that runs the stats jobs (ADR 0002) has an NVIDIA RTX 2080 Ti (11 GB), part of it used by other work.

The owner chose, on 2026-11-03:
- a local model;
- batch use in the scheduled jobs;
- live use on the site for signed-in users;
- **qwen3:8b** as the model.

## Options considered

1. **The hosted API the spec named.** Strong models and no hardware to run, but every call is billed, so use would be rationed.
2. **A local model on the home server (chosen).** Free and unmetered, so it can be used wherever it helps rather than where it is cheapest. It is a smaller model, and it is available only while the server is.
3. **The coder models already on the server** (qwen2.5-coder:14b, qwen3-coder:30b, from an earlier trial). They are tuned for code rather than prose, and at 9 GB and more they do not fit beside the GPU's other work.

## Decision

Option 2.
- **The service.** Ollama, pinned by digest, as the `ai` service in `infra/runner/compose.yml`.
- **Its network.** It sits on the runners' internal networks only, so jobs reach it at `http://ai:11434` and it has no route out.
- **The model.** qwen3:8b (about 5 GB at 4-bit), pulled once into the external volume `fantasyscout-ai-models` from a temporary container that has internet access (infra/runner/README.md).
- **Sharing the GPU.** One request and one loaded model at a time, unloaded after five idle minutes.
- **Batch.** The notes generator runs on the home runner (it needs the model). Validating its claims against the build and publishing to R2 run on a GitHub-hosted runner, which holds the R2 credentials and needs no model. The home runner's egress allow-list stays as it is.
- **Live** use reaches the model through a Cloudflare Tunnel, behind a service token that only the Worker holds. It is for signed-in users and rate-limited (#684 for accounts). It is recorded with that change.

## Consequences

- The text is cheaper to produce and can be regenerated freely. Its quality is that of an 8B model, which the validator and the evals (SPEC.md) guard: a claim that does not match the build is dropped, never published.
- AI features depend on the home server. The site keeps the last published notes when the server is down, and a live request fails with a plain message.
- Any change of model is recorded in the notes' metadata, and its evals are re-run.
