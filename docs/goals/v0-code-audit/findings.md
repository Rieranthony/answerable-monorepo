# Findings

## Orientation (2026-10-20)

- Fourth pass over this code: the test audit (4 October) settled the suite's shape, the V0 cleanup (7 October) removed line-level slop across the codebase (187 findings; `apps/id` 27,423 → 25,577 non-test lines), the v0 schema audit (19 October) settled storage (soft deletion stays everywhere by the owner's choice; scope modes 10 → 7; no audit event per refresh; ten dead columns). `apps/id/src` is now 22,990 non-test lines in 150 files.
- docs/02 "Do not re-propose" and docs/05 §11 "Accepted" list the settled decisions; the briefs carry both lists so the auditors argue against them only with new evidence.
- The admin API has 81 operation ids. Consumers use paths, not operation ids, so the grep by id found nothing conclusive; audit D builds the path-based consumer map.
- `infra/ops` holds `make-admin.ts` and `commands.ts` that read `ROOT_ADMIN_SECRET`/`OPS_ID_ROOT_SECRET`; the root secret's self-lock is therefore exercised by a Job, not a laptop.
- 13 reports under `reports/` are referenced from docs and READMEs (the release decision plan 13 times, the MCP evidence 12, `staging-evidence.md` 8 times although brief B7a has not written it yet).
- The owner's checkout: `bun.lock` and `node_modules` both from 19 October 13:21; no reinstall needed. Postgres 47432 up and healthy; Redis container exited (reserved, unused). Host has 48 GiB free; Docker build cache 11.75 GB reclaimable.

## Coordinator notes (area G, cross-cutting)

- **The root secret's self-lock is a two-party protocol with `infra/ops/make-admin.ts`**: the Job adds the person to `answerable-owner` first, then `platform-admins`, then confirms with one more call that ID answers `403 root_locked`; it fails if root still works (break-glass set). `register` runs with the root secret before the lock and with a staff token (`OPS_ID_TOKEN`, the Secret `ops-staff-token`) after it. The code is coherent; the question for B1 is the cost of the `hasPlatformWriter` query on every root request and whether the lock protects anything once the secret only lives in the GitHub environment.
- **The cookie principal is the documented path for staff with cURL**: `apps/web/content/docs/id/onboard.mdx` § Get a staff token tells a staff member to copy their browser session cookie into `Cookie:` with an `Origin:` header, create a platform-owned machine client and swap its secret for a token. The Origin check and `origin_required` in `principal.ts` exist for this. Challenge for the report: a browser cookie pasted into a shell is not an enterprise practice; the alternative is a user-delegated bearer (today refused: "User-delegated tokens are not admin credentials") or a staff client minted by `register`.
- **Every failed bearer on `/api/admin` writes an audit row** before the 401 (`principal.ts` catch block, `recordAdministrativeDenial`), and every root request runs the `hasPlatformWriter` query. B1-4 measures the amplifier.
- **`reports/staging-evidence.md` does not exist** and is linked eight times from the docs (the web link check covers only the docs site, not `docs/*.md`).
- **The ops Jobs assume an `Idempotency-Key` contract** (`MEMBERSHIP_KEYS`, `ifNoneMatch`, 412 on "already a member", `replayed`): any change to the journal (B1-1) must keep `PUT .../groups/:g/members/:m` with `If-None-Match` and the replay header, or change `infra/ops` with it.

## Audit findings (consolidated 2026-10-20)

The verdict tables are in [report.md](report.md) (unsafe U1–U6, the deletes, the simplifications, the keeps) and in each audit's section 2: [a.md](audits/a.md) 14 findings, [b1.md](audits/b1.md) 13 plus the route-to-caller map, [b2.md](audits/b2.md) 20, [c.md](audits/c.md) 12, [d.md](audits/d.md) the baseline tables.

**Cross-checks by the coordinator.**
- U1 re-run on 47433 in production mode: the five limits reproduce; the defaults read in `better-auth/dist/api/rate-limiter/index.mjs:302-315` and `@better-auth/oauth-provider/dist/authorize-BmTe2VYG.mjs:5235-5266`; `rg rateLimit apps/id/src` finds no configuration outside one test.
- U3: B1's `04b-break-glass.log` shows both `make-admin` PUTs `replayed`, the person in no live group, the Job failing with the break-glass message, `409 idempotency_key_reused` for a second person, and docs/06's key answering `201 replayed=true` with zero live rows.
- U2: `02a-bad.log` shows 28,378 rows for 28,378 requests in ten seconds, 358 B and 818 B WAL each; `08-response-fields.log` shows `deletedAt` and `live` in a group read and an organisation create.
- U4: C's `06-wrong-secret.log` shows today's build with a wrong secret running with `/readyz` 200 and `/auth/jwks` 200, and the spiked build exiting with "cannot decrypt the newest signing key".
- U5: `rg email_retired apps/id/src` finds the writer in `services/users.ts:150` only; `services/federation.ts:228-236` updates the holder with no event.
- U6: `services/sessions.ts:74` calls `recordCommandEvent` before computing `changed`.
- B1-3a: `tier` is set in `http/authorize.ts` and read by `context.ts`'s type and `tierOf` for the OpenAPI extension only.
- D's `/auth/ok` has no caller outside the allowlist and the test support; A's "each open route has a consumer" is wrong for that one route.
- No contradiction between the audits: B1 keeps the in-transaction `authorizeCommand` as the one layer and B2 removes its per-lock repetition; A9 and B1-U2 propose the same rule for refusal rows; A4 removes what C2's preflight checks, so C2's remainder is the startup check; A2b and C4 both remove the reuse interval variable.
- B1's baseline flake (`expires_in` 300 vs 299) is a test tolerance, listed under the smaller wrongs.
