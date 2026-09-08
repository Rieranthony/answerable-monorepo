# Enterprise foundation planning findings

- Prior review reproduced machine JWT authority transfer/client-ID revival, loss of person audit history, no machine issuance audit and non-idempotent secret rotation. Existing suite: 1,144 tests passed; no suite rerun in this planning task.
- Current tenancy has global users, tenant memberships, tenant groups and entitlements with composite tenant foreign keys. OAuth clients have nullable organisation ownership; resources are global.
- Tenant entitlement mutations are presently platform-only. Opening org:write without a platform ceiling would permit self-escalation.
- Global user deletion differs from tenant membership removal. Tenant offboarding must preserve access and identity belonging to other tenants.
- Provider-bound login must not automatically recreate a removed membership on the next valid upstream login; inspect admission policy before defining offboarding.
- Existing plans retain Bun/Hono/Better Auth/Postgres, prohibit email identity linking, and defer external provisioning outbox until a consumer exists.
- Proposed direction: immutable ownership and identifiers; explicit tenant request context; approved catalog ceiling plus tenant assignments; positive paired grants; transactional operation journal; immutable audit facts with restricted identity evidence; no general workflow engine.
- Installed SSO assignOrganization checks for an existing member, then creates one when absent; removal currently deletes the member. Plan a revoked membership state and test login-after-offboarding. This is a source-derived risk, not a new executed reproduction.
- Provider customAccessTokenClaims exposes user/referenceId/scopes/resources/metadata, not an authenticated client or transaction argument directly. Require a bounded integration proof for verified context and atomic success-audit/token grant; never use client metadata as authority.
- Local PostgreSQL is version 16. Shared schema remains appropriate; RLS has owner/bypass caveats and needs explicit transaction context. Prefer scoped repository boundaries everywhere, targeted defence-in-depth where provider access can be proven.
- Additional source-confirmed tenancy defect: listMemberSessions resolves userId then lists all global sessions; revokeMemberSessions calls revokeAll for that user, including every user's token row. Organisation disable similarly revokes globally by member user IDs. Tenant revocation must be redesigned before multi-tenant self-service; do not expose global session metadata/actions to tenant admins.
