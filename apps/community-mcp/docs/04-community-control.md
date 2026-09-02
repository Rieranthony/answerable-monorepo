# Community-control module

> **TL;DR**
> - **Decides:** how the tutor holds Circle credentials, mints member tokens, stores sessions and policy, and records evidence — all in Postgres.
> - **Rule:** act as the member; the admin token only behind the allowlist; every write leaves a `domain_events` row.
> - **Not here:** the tools that call it ([`03-tools-and-ui.md`](03-tools-and-ui.md)), Circle's API facts ([`02-integration-facts.md`](02-integration-facts.md)).

An in-process module of the tutor with its own Postgres schema (Drizzle, SQL migrations). It becomes a standalone service only when a second consumer needs member-token minting, or credential isolation demands the admin token live off the tutor's host.

## Schema

All state lives in Postgres; Redis becomes a read cache for `check_sessions` and `member_tokens` later.

| Table | Holds | Written by |
| --- | --- | --- |
| `course_policies` | per course: `policy` (`check` \| `manual`), `pass_threshold` (0.8), `attempts_per_day` (3) | SQL seeds for now; admin endpoints later |
| `check_sets` | per lesson: `set_version`, `questions` (JSON), `answers` (JSON), optional `pass_threshold` | SQL seeds for now; admin endpoints later |
| `check_sessions` | an in-progress check: `check_id` (uuid), `sub`, `lesson_id`, `set_version`, `attempt`, `issued_at`, `expires_at` (+30 min), `submitted_at` | the check engine |
| `member_tokens` | encrypted Circle member JWT per `sub`, `community_member_id`, `expires_at` | minting |
| `member_links` | `sub` → `community_member_id`, `link_method` (`sso_user_id` \| `email_fallback`), `email_hash`, `linked_at` | minting (once per member, ever) |
| `domain_events` | the append-only audit (below) | everything |

Seeding: `bun run db:migrate` then plain SQL (`psql "$DATABASE_URL" -f db/seed/*.sql`). Absent policy row ⇒ `check` with defaults.

## Credential custody

- **Headless Auth token** — mints member-scoped Circle JWTs (bounded by each member's own Circle permissions).
- **Admin v2 token** — allowlisted to exactly two operations: member search (the fallback below) and the progress-write fallback. Nothing else is callable, by construction; every use emits `admin_api.used`.
- Both envelope-encrypted at rest (AES-256-GCM, master key only in the runtime, key-version field for rotation); never serialized into responses, errors, or logs. Rotation via operator script, zero-downtime (read per use). Circle refresh tokens are not stored — re-mint instead (auth endpoints are MAU-exempt).

## Minting a member token

```
mintMemberToken(sub, claims) →
  member_tokens row unexpired → decrypt, return
  member_links row → mint by community_member_id → store → return
  POST /api/v1/headless/auth_token { sso_user_id: sub }        # primary, after the Circle cutover
    200 → link (sso_user_id) → store → return
    404 → fallback (below)
```

**Fallback — the primary path until the Circle SSO cutover.**

1. Require `claims.email_verified === true` from the Answerable ID token; otherwise `not_a_member`.
2. Admin v2 member search on the exact verified email. **Exactly one** active member → mint by `community_member_id`, insert `member_links` (`email_fallback`, `email_hash`), emit `member.correlated`. Zero or more than one → fail closed with `not_a_member`; emit `member.correlation_failed`.
3. Never write progress for a member reached by anything weaker than steps 1–2.

Lookups happen **once per member ever**. This path is audited, time-boxed to the fleet migration, and removed afterwards.

## Domain audit

```
domain_events  id uuidv7, occurred_at, sub, org, action, target {provider, resource_type, external_id},
               outcome, metadata jsonb (schema-validated), request_id, caller {type, client_id}
               PARTITION BY RANGE (occurred_at), monthly · app role: INSERT/SELECT only
```

Actions: `lesson.viewed`, `check.started`, `check.submitted`, `progress.completed`, `progress.reverted`, `member.correlated`, `member.correlation_failed`, `admin_api.used`.

**Completion evidence (canonical):** `{policy, check_id, set_version, score, questions_hash, answers_hash[], per_question_correct[], attempt, viewed_at, check_started_at, submitted_at, request_id}`. Raw answers are **never** stored — hashes and per-question correctness only. Retention 24 months by partition drop; erasure by `sub` via a privileged ops role (the app role cannot delete).

Quotas are derived: attempts today = count of `check.submitted` for `(sub, lesson)`.

## Progress writes

`completeLesson(sub, course, lesson, status, evidence)` → policy check (`completed` under `check` requires a submitted, passed `check_sessions` row; `manual` refuses) → member-JWT `PATCH /courses/{c}/lessons/{l}/progress` (acts as the member; Circle derives section/course completion and fires its native triggers) → `progress.completed`. Circle's PATCH is idempotent by value, so retries are safe. Admin `PUT /course_lesson_progress` is the fallback write only (`Q-ADMIN-TRIGGERS`). Revert (`status: "incomplete"`) is a SQL/operator action in v1; an admin endpoint later.

## Interface

```ts
mintMemberToken(sub, claims): { accessToken, expiresAt, communityMemberId }
getPolicy(courseId): { policy: "check" | "manual", passThreshold, attemptsPerDay }
getCheckSet(lessonId): { setVersion, questions, answers, passThreshold? }
openCheckSession(sub, lessonId): { checkId, questions, attempt, expiresAt }
gradeCheckSession(checkId, sub, answers): { passed, score, perQuestion }
attemptsUsedToday(sub, lessonId): number
recordEvent(event): void
completeLesson(sub, courseId, lessonId, status, evidence): { recorded, providerStatus }
```

Every function is written test-first against the local environment (`tutor_test` database, Circle mocks or recorded fixtures). If extracted into a service, these signatures become the API; the tool layer does not change.
