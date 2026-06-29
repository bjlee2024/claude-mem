# Project Merge Unique-Constraint Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix `PostgresProjectsRepository.renameOrMerge` so it handles UNIQUE-constraint collisions during the merge path by deleting duplicate `from` rows before re-assigning `project_id`.

**Architecture:** Before each `UPDATE <table> SET project_id = $to` for tables that carry a `project_id`-bearing UNIQUE constraint, issue a `DELETE` that removes `from` rows whose unique-key columns already match a `to` row. Child rows of deleted sessions keep their data because all `server_session_id` FKs use `ON DELETE SET NULL`. Tables without such a constraint (`api_keys`, `audit_log`, `agent_events`) keep their plain `UPDATE`.

**Tech Stack:** TypeScript, Bun, node-postgres (`pg`), Bun test.

## Global Constraints

- All queries scoped by `team_id` as well as `project_id`.
- Transaction keeps `SET CONSTRAINTS ALL DEFERRED` (needed for 3-way deferred FK on `observation_generation_jobs → agent_events`).
- No schema migrations — the fix is purely in application-layer SQL.
- Files: `src/storage/postgres/projects.ts`, `tests/storage/projects-rename.test.ts`.

---

### Task 1: Implement DELETE-before-UPDATE in `renameOrMerge`

**Files:**
- Modify: `src/storage/postgres/projects.ts:102-134`

**Interfaces:**
- Consumes: `this.client.query(sql, params)` (already exists)
- Produces: same `renameOrMerge` signature; merge path now pre-deletes conflicting rows

The four unique constraints that require pre-deletion:

| Table | Unique key columns (besides project_id/team_id) | Partial predicate |
|---|---|---|
| `server_sessions` | `external_session_id` | none (inline UNIQUE) |
| `server_sessions` | `idempotency_key` | `WHERE idempotency_key IS NOT NULL` |
| `observations` | `generation_key` | `WHERE generation_key IS NOT NULL` |
| `observation_generation_jobs` | `source_type, source_id, job_type` | none |

- [ ] **Step 1: Replace the merge loop with explicit per-table statements**

Replace lines 102–134 in `src/storage/postgres/projects.ts` (the `referencingTables` array, the loop, the `DELETE FROM projects`, and the `COMMIT`) with the explicit block below:

```typescript
    // Merge: delete from-rows that would collide on a unique constraint, then
    // reassign remaining from-rows to to, then delete the from project.
    await this.client.query('BEGIN');
    try {
      // Defer the 3-way FK observation_generation_jobs → agent_events so we
      // can update agent_events.project_id before observation_generation_jobs.
      await this.client.query('SET CONSTRAINTS ALL DEFERRED');

      // ── api_keys: no project_id-bearing unique constraint → plain UPDATE ──
      await this.client.query(
        `UPDATE api_keys SET project_id = $1 WHERE project_id = $2 AND team_id = $3`,
        [toRow.id, fromRow.id, teamId]
      );

      // ── audit_log: no project_id-bearing unique constraint → plain UPDATE ──
      await this.client.query(
        `UPDATE audit_log SET project_id = $1 WHERE project_id = $2 AND team_id = $3`,
        [toRow.id, fromRow.id, teamId]
      );

      // ── server_sessions: TWO unique keys involving project_id ──
      // Unique 1: (project_id, external_session_id)
      // Unique 2: (project_id, idempotency_key) WHERE idempotency_key IS NOT NULL
      // Delete any from-session that collides on EITHER key.
      await this.client.query(
        `DELETE FROM server_sessions f
          WHERE f.project_id = $1 AND f.team_id = $2
            AND (
              EXISTS (
                SELECT 1 FROM server_sessions t
                WHERE t.project_id = $3 AND t.team_id = $2
                  AND t.external_session_id = f.external_session_id
              )
              OR (
                f.idempotency_key IS NOT NULL
                AND EXISTS (
                  SELECT 1 FROM server_sessions t
                  WHERE t.project_id = $3 AND t.team_id = $2
                    AND t.idempotency_key = f.idempotency_key
                )
              )
            )`,
        [fromRow.id, teamId, toRow.id]
      );
      await this.client.query(
        `UPDATE server_sessions SET project_id = $1 WHERE project_id = $2 AND team_id = $3`,
        [toRow.id, fromRow.id, teamId]
      );

      // ── agent_events: UNIQUE (id, project_id, team_id) includes own id → no collision ──
      await this.client.query(
        `UPDATE agent_events SET project_id = $1 WHERE project_id = $2 AND team_id = $3`,
        [toRow.id, fromRow.id, teamId]
      );

      // ── observation_generation_jobs: UNIQUE (team_id, project_id, source_type, source_id, job_type) ──
      await this.client.query(
        `DELETE FROM observation_generation_jobs f
          WHERE f.project_id = $1 AND f.team_id = $2
            AND EXISTS (
              SELECT 1 FROM observation_generation_jobs t
              WHERE t.project_id = $3 AND t.team_id = $2
                AND t.source_type = f.source_type
                AND t.source_id = f.source_id
                AND t.job_type = f.job_type
            )`,
        [fromRow.id, teamId, toRow.id]
      );
      await this.client.query(
        `UPDATE observation_generation_jobs SET project_id = $1 WHERE project_id = $2 AND team_id = $3`,
        [toRow.id, fromRow.id, teamId]
      );

      // ── observations: UNIQUE (team_id, project_id, generation_key) WHERE generation_key IS NOT NULL ──
      await this.client.query(
        `DELETE FROM observations f
          WHERE f.project_id = $1 AND f.team_id = $2
            AND f.generation_key IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM observations t
              WHERE t.project_id = $3 AND t.team_id = $2
                AND t.generation_key = f.generation_key
            )`,
        [fromRow.id, teamId, toRow.id]
      );
      await this.client.query(
        `UPDATE observations SET project_id = $1 WHERE project_id = $2 AND team_id = $3`,
        [toRow.id, fromRow.id, teamId]
      );

      await this.client.query('DELETE FROM projects WHERE id = $1', [fromRow.id]);
      await this.client.query('COMMIT');
    } catch (e) {
      await this.client.query('ROLLBACK');
      throw e;
    }
    return { id: toRow.id, name: to, merged: true };
```

- [ ] **Step 2: Remove the now-unused `referencingTables` array** (lines 105–112 in the original).

---

### Task 2: Update unit tests

**Files:**
- Modify: `tests/storage/projects-rename.test.ts`

The existing merge test (`merges when "to" project already exists`) checks that every referencing table gets an `UPDATE SET project_id`. Update it to also verify:
- A `DELETE` precedes the `UPDATE` for `server_sessions`, `observation_generation_jobs`, and `observations`.
- `api_keys`, `audit_log`, and `agent_events` get only an `UPDATE` (no preceding DELETE).
- DELETE SQL for `server_sessions` matches the two-key correlated-subquery form.
- DELETE SQL for `observation_generation_jobs` matches the source-key correlated-subquery form.
- DELETE SQL for `observations` matches the generation-key correlated-subquery form.

- [ ] **Step 1: Add regex patterns and per-table assertions to the merge test**

Add the following patterns near the top of the test file (after the existing regex block):

```typescript
const DELETE_SESSION_CONFLICT = /DELETE FROM server_sessions f\s+WHERE f\.project_id/i;
const DELETE_OBS_CONFLICT = /DELETE FROM observations f\s+WHERE f\.project_id/i;
const DELETE_JOB_CONFLICT = /DELETE FROM observation_generation_jobs f\s+WHERE f\.project_id/i;
```

Then extend the `merges when "to" project already exists` test body:

```typescript
    // ── Verify DELETE-before-UPDATE for server_sessions ──
    const sessionDeletes = c.calls.filter((q) => DELETE_SESSION_CONFLICT.test(q.sql));
    expect(sessionDeletes.length).toBe(1);
    expect(sessionDeletes[0].params).toEqual(['from-id', 'team1', 'to-id']);
    const sessionUpdates = c.calls.filter((q) => UPDATE_REF.test(q.sql) && q.sql.includes('server_sessions'));
    expect(sessionUpdates.length).toBe(1);
    const sessionDeleteIdx = c.calls.findIndex((q) => DELETE_SESSION_CONFLICT.test(q.sql));
    const sessionUpdateIdx = c.calls.findIndex((q) => UPDATE_REF.test(q.sql) && q.sql.includes('server_sessions'));
    expect(sessionDeleteIdx).toBeLessThan(sessionUpdateIdx);

    // ── Verify DELETE-before-UPDATE for observation_generation_jobs ──
    const jobDeletes = c.calls.filter((q) => DELETE_JOB_CONFLICT.test(q.sql));
    expect(jobDeletes.length).toBe(1);
    expect(jobDeletes[0].params).toEqual(['from-id', 'team1', 'to-id']);
    const jobUpdateIdx = c.calls.findIndex((q) => UPDATE_REF.test(q.sql) && q.sql.includes('observation_generation_jobs'));
    const jobDeleteIdx = c.calls.findIndex((q) => DELETE_JOB_CONFLICT.test(q.sql));
    expect(jobDeleteIdx).toBeLessThan(jobUpdateIdx);

    // ── Verify DELETE-before-UPDATE for observations ──
    const obsDeletes = c.calls.filter((q) => DELETE_OBS_CONFLICT.test(q.sql));
    expect(obsDeletes.length).toBe(1);
    expect(obsDeletes[0].params).toEqual(['from-id', 'team1', 'to-id']);
    const obsUpdateIdx = c.calls.findIndex((q) => UPDATE_REF.test(q.sql) && q.sql.includes('observations') && !q.sql.includes('observation_'));
    const obsDeleteIdx = c.calls.findIndex((q) => DELETE_OBS_CONFLICT.test(q.sql));
    expect(obsDeleteIdx).toBeLessThan(obsUpdateIdx);

    // ── Verify no DELETE for api_keys, audit_log, agent_events ──
    const unexpectedDeletes = c.calls.filter(
      (q) => /DELETE FROM (api_keys|audit_log|agent_events)/i.test(q.sql)
    );
    expect(unexpectedDeletes.length).toBe(0);
```

- [ ] **Step 2: Update the `refUpdates.length` assertion**

The old test asserts `refUpdates.length === expectedReferencingTables.length` (6 updates). The new code still issues 6 UPDATEs (one per table), so this assertion stays at 6. No change needed here.

---

### Task 3: Run unit tests and type check

- [ ] **Step 1: Run unit tests**

```bash
cd /home/bj/Work/servers/claude-mem && bun test tests/storage/projects-rename.test.ts
```

Expected output: all tests PASS (≥5 tests).

- [ ] **Step 2: Run TypeScript type check**

```bash
cd /home/bj/Work/servers/claude-mem && npx tsc --noEmit
```

Expected: no errors.

---

### Task 4: Integration test on scratch Postgres

**Files:**
- Create (temp): `/tmp/claude-1000/-home-bj-Work-servers-claude-mem/49bb3c63-3f28-44e4-a8e1-80266d05238f/scratchpad/integration-merge-test.ts`

- [ ] **Step 1: Get Postgres password and IP**

```bash
PG_PASS=$(docker exec claude-mem-postgres-1 printenv POSTGRES_PASSWORD)
PG_IP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' claude-mem-postgres-1)
echo "IP=$PG_IP PASS=$PG_PASS"
```

- [ ] **Step 2: Write and run the integration script**

The script must:
1. Connect as `admin` to `claudemem` DB.
2. Drop and recreate scratch DB `mergetest`.
3. Connect to `mergetest`, bootstrap schema via `bootstrapServerBetaPostgresSchema`.
4. Insert team, two projects (`alpha`, `beta`), a `server_session` under each with the SAME `external_session_id` (this is the collision), plus a non-colliding session under `alpha`.
5. Call `renameOrMerge('team1', 'alpha', 'beta')` — expect no throw.
6. Assert: `alpha` project row is gone; only one session with `external_session_id='ext-1'` exists (under `beta`); the non-colliding `alpha` session moved to `beta`.
7. Drop `mergetest`.

---

### Task 5: Commit and write report

- [ ] **Step 1: Commit**

```bash
git add src/storage/postgres/projects.ts tests/storage/projects-rename.test.ts
git commit -m "fix(storage): delete duplicate rows before merge to avoid UNIQUE violations"
```

- [ ] **Step 2: Write report to `.superpowers/merge-fix-report.md`**

Append the per-table SQL, integration test result, and cleanup notes.
