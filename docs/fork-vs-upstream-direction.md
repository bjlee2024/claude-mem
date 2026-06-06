# Direction & Architecture — Fork vs. Upstream

> A comparison of the **architectural direction** of upstream `thedotmack/claude-mem`'s
> server-beta design versus the direction this fork (`@bjlee2024/claude-mem`) actually
> applied on top of it.
>
> **Sources analyzed** (pure upstream, unmodified by the fork):
> `server-beta-architecture-and-team-vision.md`, `server-beta-parity-map.md`,
> `server-beta-release-readiness.md`, `server-storage-boundary.md`, `server.md` —
> cross-referenced against the fork's 78 commits and [FORK.md](./FORK.md).

---

## 0. Thesis in one line

| | Core intent | Slogan |
|---|---|---|
| **Upstream (thedotmack)** | **scale-OUT** — grow the 1-person tool into a **multi-tenant team→org shared-memory substrate (SaaS-grade)** | *"memory that writes itself, **for everyone**"* |
| **Fork (bjlee2024)** | **scale-IN** — repurpose that substrate as a **single-user, multi-device personal memory pool** (laptop · desktop · server box) | *"one person's memory, on every device"* (Tailscale home-lab) |

These are **not in conflict — they point in opposite directions.** Upstream treats the
single user as a *degenerate case* (`team_id = local-hook-team`) and makes **shared memory
across many principals** the first-class citizen. The fork makes **spreading one tenant
across several devices** the first-class citizen and treats teams/orgs as a non-goal.

---

## 1. Axis-by-axis contrast

| Design axis | Upstream server-beta | Direction the fork applied |
|---|---|---|
| **Server location** | Local daemon (UID-derived port `37877+uid%100`); hooks call a server on the **same machine** | **Remote** server; hooks call **across the network** (Tailscale) — a new `client` runtime |
| **Tenancy** | `team_id × project_id` is the organizing principle; every read is scope-keyed | Tenancy is **plumbing** — one team, fixed/auto-resolved project; effectively bypassed |
| **Auth philosophy** | **Zero-trust**: scoped API keys, revocation, **audit chain (SOC2/ISO)**, worker re-validation, scope-violation refusals | **Trusted network**: an enrollment token to "join my server"; shared key + Tailnet boundary. A **join gate, not a governance surface** |
| **Generation economics** | Each worker brings **its own provider key** (`ANTHROPIC_API_KEY`); per-team cost attribution / chargeback | **Zero client keys.** Server generates via **Claude subscription OAuth** or **Ollama (local model)** → zero per-call cost |
| **Settings model** | "settings = env vars" (12-factor, immutable, ops-managed); `/api/settings` explicitly **unsupported** | **Mutable `/api/settings` re-introduced** + viewer Save (a solo user wants to toggle in the UI) |
| **Viewer** | server-beta data routes **deferred** ("call `/v1` directly, follow-up phase") | **Built now** (`ServerViewerDataRoutes`) — a self-hoster needs the viewer on day one |
| **Network assumption** | Server always reachable (it's local) | **Assumes flakiness** → **offline write spool** (NDJSON append/replay) + crash recovery |
| **Scaling unit** | `docker compose --scale worker=N`, k8s HPA, multi-region | A single server box. Horizontal scale is a non-goal |
| **Upper product vision** | feeds · trust labels · federation · marketplace · cost dashboards · compliance reports | **Restoring single-user UX** (startup context · session-summary panel · search · viewer) |

---

## 2. Where they align — the fork completes upstream's deferred backlog

Everything `server-beta-parity-map.md` marked **`unsupported` / "follow-up phase"** is what the
fork implemented. The fork did **not** fight the architecture — it **filled the seats upstream
explicitly left empty**:

| Deferred by upstream (parity-map / vision §15) | Filled by the fork |
|---|---|
| Data viewer routes — *"note 2: follow-up phase"* | `ServerViewerDataRoutes` (observations/stats/projects/processing/summaries/prompts) |
| `/api/settings` — *"env vars, unsupported"* | `POST /api/settings` + `{success:true}` (13.4.13–14) |
| `/api/context/preview`·`inject`·`semantic` — *unsupported* | `/api/context/preview` (13.4.11), client-side ContextBuilder rendering |
| Legacy search → `/v1/search` migration intent | client-mode search / timeline / get_observations |
| (server-beta did not serve `/api/context/inject`) | SessionStart context + **session-summary panel + 1970 timestamp fix** |

The difference is **purpose**: upstream drew these routes as a future *team viewer / product
surface*; the fork built them as *self-hosted single-user UX*.

---

## 3. Where the philosophy diverges (trade-offs)

1. **Trust model runs in opposite directions**
   - Upstream: *fear of garbage data → make every observation traceable to `(api_key_id,
     actor_id, request_id, model_id)` → that auditability is the precondition for trust*
     (vision §14.8).
   - Fork: *my devices bound by Tailscale → the network boundary is the trust* → one
     enrollment instead of heavy scopes/audit. **Enough for a personal Tailnet, insufficient
     for an org.**

2. **Generation cost model is inverted**
   - Upstream: multi-provider + per-key cost attribution = a **chargeback / governance asset**.
   - Fork: subscription / local model = **eliminating the solo user's per-call cost**. Cost
     attribution is moot (it's one person).

3. **State philosophy**
   - Upstream: immutable env + Postgres-as-truth = **deployability / reproducibility**.
   - Fork: mutable settings + viewer save = **a solo user's instant adjustability** (a small
     step back from 12-factor).

---

## 4. The genuinely new architecture the fork added

On top of upstream's substrate, the fork built design pieces upstream did **not** have:

- **Remote thin-client runtime** (`CLAUDE_MEM_RUNTIME=client`) — a third runtime distinct
  from upstream's `server-beta` (local daemon). Adds `ProjectResolver` (repo-name → UUID
  cache), `ClientWriter`, best-effort lifecycle.
- **Offline spool + crash recovery** — a write buffer that survives network loss (upstream is
  local, so it never needed one).
- **Subscription / local generation providers** — `ClaudeSubscriptionObservationProvider`
  (OAuth bearer) and Ollama. **Reuses** upstream's provider abstraction (`generate()`) while
  adding a new "keyless generation" economic model.
- **Enrollment-token flow** — repackages upstream's teams/api_keys primitives into a personal
  "join my server" UX.

In short: the fork is a **last-mile implementation that borrows upstream's multi-tenant
plumbing and layers a "remote + keyless + resilient" client tier on top.**

---

## 5. Forward tension (maintenance implications)

- As upstream pursues its §15 backlog (**default-private mode, federation UX, cost
  dashboards**), it will **diverge further** from the fork's "single trusted network"
  assumption. Merge hotspots when syncing upstream: ① mutable settings (fork) vs env-only
  (upstream), ② viewer data-route shapes, ③ auth strength.
- The fork's weakness is the exact mirror of upstream's strength: **shallow audit / scope /
  multi-provider cost attribution**. To widen the fork toward "small-team sharing," the
  tenancy and audit layers it currently bypasses would have to be promoted back to
  first-class — i.e. a regression *toward* the upstream direction.
- Conversely, if upstream embraces "solo self-host UX" (viewer / settings / subscription
  generation), the fork's changes become **back-port candidates** upstream — especially
  `ServerViewerDataRoutes`, the subscription provider, and the client runtime.

---

## Conclusion

Upstream aims at **"shared · auditable · scalable"**; the fork aims at **"personal · zero-cost ·
resilient + restoring the single-user UX that upstream deferred."** The fork does **not**
contradict upstream's architecture — it **narrows the substrate to a single tenant** and
implements the client/viewer surfaces upstream parked in a "follow-up phase." A branch whose
**direction is opposite (out ↔ in) but whose foundation is shared.**
