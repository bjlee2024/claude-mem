# Journey Into claude-mem

*A technical history reconstructed from claude-mem's own persistent memory — 393 observations spanning roughly 24 hours of intense work on a forked, self-hosted memory system.*

> Timestamps below are quoted in the project's local timezone (KST, UTC+9). The underlying epoch data runs from 2026-06-05 18:21 UTC to 2026-06-06 17:46 UTC, which is 2026-06-06 03:21 to 2026-06-07 02:46 local. Observation references use the chronological index (`#N`) into the oldest-first timeline.

---

## 1. Project Genesis

This window of work did not begin with a clean slate or a fresh feature idea. It began with something subtler and more revealing: a developer noticing that their own memory plugin had quietly stopped working correctly after an architectural migration. The very first observations (`#0`–`#5`, Jun 6 ~03:21) show the agent fanning out across `src/cli/handlers/session-init.ts`, the runtime selector, and the `/health` endpoint — and almost immediately hitting a wall. At `#5` (Jun 6 03:22) a `curl` to `/health` returned `NotFound`, and at `#11` (Jun 6 03:23) a `security_alert` fired: the `SessionStart` context hook was throwing a *module not found* error.

The problem being solved was concrete. claude-mem had been migrated from a local **worker** runtime (SQLite, in-process) toward a **client/server-beta** runtime (a remote HTTP server backed by PostgreSQL). The migration was functionally incomplete. Two user-visible regressions surfaced almost at once:

1. **Session summaries had disappeared from the SessionStart context panel.** The investigation at `#46`–`#47` (Jun 6 03:34) pinned this to `ContextBuilder.ts:132,135` and the client hook in `context.ts:51-58`: `buildContextOutput` could process summaries, but the client path *hardcoded an empty summaries array and an undefined session ID*, so summary rows that genuinely existed in `ctx.observations` were silently ignored.
2. **The "1970 bug."** At `#46` the agent found that `serializeObservation` in `ServerV1PostgresRoutes.ts` emits `createdAtEpoch`, but the client hook fell back to a non-existent `created_at` field and defaulted to the Unix epoch — dating *every* server-sourced observation to January 1, 1970.

So the genesis was a debugging investigation into a half-finished migration, framed early by an explicit decision point at `#21` (Jun 6 03:28, a `decision`): should the developer revert to worker mode, port summary support into the client path, fix only the bugs, or merely analyze? The chosen path — port and fix without a server restart — set the tone for everything that followed.

---

## 2. Architectural Evolution

The structural story of this window is the **worker-to-server migration reaching maturity**, told in two arcs separated by a documentation interlude.

**The client/server split, made real.** The runtime selector (`#3`, `src/services/hooks/runtime-selector.ts`) reads `~/.claude-mem/settings.json` to decide whether a hook calls server-beta endpoints or falls through to the legacy worker compat path. This is the architectural fault line that runs through the entire timeline. Early observations (`#17`, `#18`) note a stark *difference in observation counts between the old SQLite worker DB and the server-beta PostgreSQL backend* — the two storage systems were not in sync, and the new one was authoritative for new data.

**Read-path parity as the central design problem.** The migration's hardest architectural truth is captured in the mid-session "parity map" observations (`#114`, `#302`, `#309`, Jun 6 ~03:25 and ~13:52). The team documented every legacy worker HTTP route under `/api/` and classified its server-beta status as `native`, `adapter`, or `unsupported`. The gap analysis at `#196`–`#199` (Jun 6 ~13:30) crystallized the consequence: skills like `timeline-report`, `weekly-digests`, and `knowledge-agent` were *broken in client mode* because their required endpoints (`/api/context/inject`, `/api/timeline`, `/api/corpus/*`) simply did not exist server-side.

The architectural response was deliberate and is the spine of the second half of the day:

- A new **`POST /v1/timeline`** endpoint (`#310`, `#320`) offering fully paginated access to all observations *including summaries*, so the timeline/digest skills could read from PostgreSQL the way they once read from SQLite.
- A **context-preview endpoint** (`#237`) that reuses the *same shared pure formatter* the worker uses, rendering Postgres rows into context identically to SQLite rows — a conscious choice to keep one rendering path rather than fork it.
- A full **corpus management API** (`#257`, `CorpusRoutes`) covering build/list/get/delete/rebuild/prime/query, plus refactored **v1 event ingestion** (`#318`) supporting single and batch submission (up to 500 events) with pre-validation and async-job waiting.
- PostgreSQL storage primitives: agent-event handling (`#207`, `src/storage/postgres/agent-events.ts`), idempotency keys for observation jobs (`#206`), and pagination support in observation queries (`#313`).

The architecture that emerged is a *single-tenant, self-hosted mirror* of an upstream multi-tenant design — a distinction the developer documented explicitly (see Memory and Continuity below).

---

## 3. Key Breakthroughs

Several genuine "aha" moments punctuate the timeline.

**The dual-bug root cause (Jun 6 03:34–03:42, `#46`–`#72`).** The breakthrough was realizing the summary problem and the 1970 problem were *both* client-mapper defects, not server bugs — and crucially that **summaries are just observation rows of a specific kind**, already present in the payload. That reframe (`#72`) meant the fix could be client-only, requiring no server restart (`#87`, Jun 6 03:47). One insight collapsed two bugs and avoided a deployment.

**The parity map as a planning instrument (Jun 6 ~13:30, `#196`–`#199`).** Rather than chase individual skill failures, the developer stepped back and audited *which skills touch the local worker/DB versus the MCP/server* (`#193`–`#194`), then mapped the missing endpoints. This turned a vague "skills are flaky" complaint into a precise, finite checklist of endpoints to build.

**`/v1/timeline` as the unlocking primitive (Jun 6 ~13:53, `#310`).** Recognizing that one well-designed paginated read endpoint — returning observations *and* summaries — would simultaneously fix `timeline-report` and `weekly-digests` was the leverage point of the whole second sprint.

**The English-only directive (Jun 6 ~16:39, `#385`).** A small but decisive fix: the server's generation prompt had been emitting Chinese titles (visible in this very timeline at `#115`, whose title and subtitle are in Chinese — translated: *"Comparing the direction and architecture of upstream vs. the fork: upstream favors sharing, auditing, and extensibility, while the fork favors personal use, zero cost, and resilience"*). The breakthrough was diagnosing that *no output language was specified* in the prompt, then adding an explicit `LANGUAGE` directive to force English while preserving code identifiers.

---

## 4. Work Patterns

The rhythm of this day is unusually legible because the kind-distribution is so skewed: of 393 observations, **333 are `discovery`** (85%), with only 30 `feature`, 16 `change`, 6 `bugfix`, 3 `decision`, 2 `refactor`, 2 `security_alert`, and 1 `security_note`. This is the signature of an **investigation-heavy workflow**: long reconnaissance phases (Grep, Read, Bash) punctuated by short bursts of committed change.

Three distinct phases emerge:

1. **Bug-fix sprint (Jun 6 03:21–03:47, `#0`–`#87`).** Tight debugging cycle: locate, diagnose (`#46`–`#47`), confirm via the "1970" grep (`#73`), clean up stale Docker/Postgres test data (`#77`–`#79`), build-and-sync (`#83`–`#86`), run regression tests (`#86`), commit (`#87`). A textbook investigate-fix-verify loop.

2. **Documentation and merge interlude (Jun 6 ~12:57–14:44, `#88`–`#162`).** The developer pivoted to fork hygiene: authored `FORK.md` (`#100`), a `fork-vs-upstream-direction.md` comparison (`#115`, `#118`), and Ollama/local-model docs (`#98`), then pulled `upstream/main`, hit merge conflicts in build artifacts (`#123`, `#127`–`#135`), resolved them, ran a careful pre/post-merge test-baseline comparison (`#140`–`#149`) to ensure the merge introduced *no new failures*, and merged (`#151`).

3. **Feature sprint (Jun 6 ~22:26–Jun 7 ~02:46, `#163`–`#392`).** The longest and densest phase — the 13:00–14:00 UTC block alone holds ~148 observations. A sustained server-beta build-out (timeline endpoint, corpus routes, CLI `timeline` command), a release (`#364`), and a final language-policy fix.

The pattern within each sprint is consistent: **exhaustive read-only reconnaissance, then a small cluster of writes, then build + typecheck + test + commit.** The developer never built blind.

---

## 5. Technical Debt

The window is, in large part, a story of *paying down* debt incurred by the earlier worker-to-server migration — and incurring a little new debt along the way.

**Debt paid back:**
- The hardcoded empty summaries array and the 1970 fallback (`#47`, `#46`) were classic migration shortcuts — placeholder client logic left behind when the server path was stubbed. Fixed and committed at `#102`/`#105` (commit `d4cf3d7e`).
- The `unsupported` endpoints in the parity map were acknowledged debt; the `/v1/timeline` and corpus routes work (`#257`, `#310`, `#320`) directly retired several of them.
- Build-artifact merge conflicts (`#123`, `#135`) — `viewer-bundle.js`, `server-beta-service.cjs`, generated `bun-runner.js` — are the recurring tax of committing built artifacts alongside source. The developer resolved them by regenerating rather than hand-merging (`#135`).

**Debt deliberately deferred:**
- **Token Economics.** At `#306` (Jun 6 ~13:53) the developer discovered the server schema lacks `discovery_tokens`, `source_tool`, and `source_input_summary` columns — token usage simply *is not persisted server-side*. Rather than backfill the schema, the decision at `#311` (Jun 6 14:02) was explicit: execute Phases 1–5 but **exclude server-mode Token Economics**. A scoped, conscious omission.
- **knowledge-agent in client mode.** Instead of porting the full corpus pipeline, the corpus tools were *gated* to return a guidance message (`#330`, `#343`) directing users to the `mem-search`/`search` MCP tool. A guidance gate is debt, but a documented and intentional one.
- **Historical data.** The final observations (`#390`, `#392`) note the server-beta backend holds *only 6/5–6/6 data*; worker-era history was not migrated. Acknowledged as a known scope limitation requiring a future migration.

---

## 6. Challenges and Debugging Sagas

**The push-permission saga (Jun 6 ~03:58–04:44, `#152`–`#162`).** After merging upstream, the push to `main` was rejected: the merge touched `.github/workflows/ci.yml`, and the OAuth App lacked the `workflow` scope (`#152`). The developer first tried diagnosing token scopes (`#155`, `#157`), then attempted SSH — which failed with permission-denied (`#156`, a `security_note`), then discovered there was *no SSH config for the `github-medit` host* (`#158`). The resolution at `#161`–`#162` was to reconfigure the origin to an SSH URL and authenticate as `bjlee2024` over SSH, **bypassing the OAuth workflow-scope limitation entirely**. A multi-step dead-end-laden investigation that ended in an infrastructure workaround rather than a code fix.

**The cache/version-mismatch saga (Jun 6 ~14:26–15:31, `#351`–`#376`).** After shipping the `timeline` CLI command, the feature didn't appear to work for end users. The hunt was layered: a Docker Compose env var was unset (`#351`), then the build-and-sync worker restart misbehaved (`#353`), then the *cached plugin bundle didn't match the published npm version* (`#354`). The developer verified string literals survived minification (`#356`), found uncommitted artifacts and an npm-publish gap (`#357`), and concluded (`#358`–`#359`) that the only real fix was to **publish a new npm version** so `npx claude-mem` would resolve the new command. That publish then hit its *own* wall — an EOTP one-time-password requirement (`#370`, a `security_alert`) — forcing an `npm login` (`#363`) before `13.4.18` could ship (`#364`, `#376`). A chain where each fix exposed the next layer.

**The merge-baseline verification.** Less dramatic but methodologically notable: at `#140`–`#149` the developer refused to trust the merged tree's test failures at face value, instead establishing a *pre-merge baseline* (`#141`), isolating failing tests (`#143`–`#144`), and even validating *without the local `.env`* (`#148`) to rule out environment contamination. The conclusion (`#347`) — "no new failures compared to baseline" — was earned, not assumed.

---

## 7. Memory and Continuity

This window is uniquely self-referential: the project being debugged *is* the memory system that recorded the debugging. That recursion shows up in several ways.

The clearest continuity artifact is the **cross-session reasoning at `#115`** (Jun 6 03:27), where the developer wrote a Chinese-language architectural comparison of upstream vs. fork — capturing a *philosophical* decision (upstream = multi-tenant, shared, audited, extensible; fork = single-tenant, personal, zero-cost, resilient) and persisting it as `docs/fork-vs-upstream-direction.md` (`#118`). This is memory used not for code recall but for *intent recall* — recording the "why" so future sessions inherit the design philosophy. Notably, this observation is the one that later motivated the English-only fix, because it demonstrated the generation model would happily emit CJK when unconstrained.

The **parity map** (`#114`, `#302`, `#309`) functions the same way: a durable, queryable record of which routes are `native`/`adapter`/`unsupported`, so the migration's state survives across sessions rather than living only in the developer's head.

And the window *closes* on a memory-about-memory note. The final observations (`#389`–`#392`, Jun 7 ~02:46) record the developer fetching this very timeline (389 observations, ~146k tokens), discovering the server-beta backend holds only recent data, estimating the report's own token cost (`#391`, >100K tokens), and noting the migration path forward (`claude plugin update bjlee2024/claude-mem`). The system's last act in this window was to remember the conditions under which it would be asked to remember.

---

## 8. Timeline Statistics

- **Date range (local KST):** 2026-06-06 03:21 → 2026-06-07 02:46 (≈23.5 hours).
- **Date range (UTC):** 2026-06-05 18:21 → 2026-06-06 17:46.
- **Total observations analyzed:** 393.
- **Breakdown by kind:**

  | kind | count |
  |---|---|
  | discovery | 333 |
  | feature | 30 |
  | change | 16 |
  | bugfix | 6 |
  | decision | 3 |
  | refactor | 2 |
  | security_alert | 2 |
  | security_note | 1 |

- **Most active periods (by UTC hour bucket):**
  - 13:00 UTC (Jun 6 / 22:00 KST): **148 observations** — the server-beta feature sprint, by far the densest hour.
  - 18:00 UTC (Jun 5 / 03:00 KST): **88 observations** — the opening bug-fix sprint.
  - 03:00 UTC (Jun 6 / 12:00 KST): **59 observations** — the documentation + upstream-merge work.
  - 14:00 UTC (Jun 6 / 23:00 KST): **49 observations** — CLI command, release prep, version mismatch hunt.
  - Lighter tails at 02:00, 04:00, 15:00, 16:00, 17:00 UTC.

The work clusters into three peaks (open bug-fix, mid documentation/merge, late feature build) consistent with the three phases described in *Work Patterns*.

_Token Economics is unavailable in server/client mode (token data is not persisted server-side)._

---

## 9. Lessons and Meta-Observations

A developer joining this project would take away a handful of durable principles, each earned in the day's record:

1. **Migrations leave landmines in the placeholder layer.** Both opening bugs (`#46`, `#47`) were not server defects but *client-side stubs* — `summaries: []`, a fabricated `created_at` — left behind when the server path was scaffolded. When porting a runtime, audit every hardcoded fallback; the stubs you forget become the bugs you ship.

2. **Map the gap before you close it.** The parity map (`#114`, `#302`) and the skill data-access audit (`#193`–`#199`) turned diffuse "things are broken" frustration into a finite endpoint checklist. Inventory first, build second.

3. **One good primitive beats many patches.** `POST /v1/timeline` (`#310`) fixed two skills at once; the shared pure formatter (`#237`) kept worker and server rendering identical. Look for the read path that unlocks the most surface area.

4. **Verify against a baseline, not against zero.** The merge work (`#140`–`#149`, `#347`) only trusted "no regressions" after establishing a pre-merge baseline and isolating env effects. Test failures mean nothing without a control.

5. **Shipping is a pipeline, and every stage can fail.** The version-mismatch saga (`#351`–`#376`) shows that a working `git commit` is not a shipped feature: cache bundles, minification, npm publish, and OTP auth each gated the actual delivery. "Done" means *resolvable by `npx`*, not *committed locally*.

6. **Constrain generative output explicitly.** The English-only fix (`#385`, `#388`) is a reminder that an LLM-backed pipeline will drift (here, into Chinese) unless the prompt *names* the constraint. Defaults are not guarantees.

7. **Record intent, not just code.** The fork-direction doc (`#115`, `#118`) and the parity map persisted the *reasoning* behind the architecture — the most valuable thing a memory system can carry across sessions, and fittingly, the thing this memory system chose to remember about itself.

The throughline: this was a day of finishing what an earlier migration had started — paying down its debt, mapping its gaps, building the read paths it lacked, and shipping the result — conducted with a discipline (reconnaissance before writes, baselines before claims, primitives before patches) that the persistent memory itself both enabled and recorded.
