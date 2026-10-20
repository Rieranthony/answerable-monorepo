# Production user OAuth

The protocol design of ID's user OAuth (code, refresh and consent on the pinned Better Auth OAuth provider). Trimmed on 20 October 2026 by the [v0 code audit](../docs/goals/v0-code-audit/report.md) to the prose that still describes the code; the implementation evidence and its logs are in git history. The audit events are in [docs/04](../docs/04-answerable-id-schema.md#audit-actions); the public contract is the [OAuth guide](../apps/web/content/docs/id/oauth.mdx).

## Protocol and authority

The installed Better Auth OAuth provider (1.7.2) remains responsible for request
validation, signed browser continuation, PKCE, client authentication, code
consumption, token signing, refresh rotation, UserInfo and revocation. The
production composition wraps its supported endpoint, post-login, claims and
database-adapter boundaries. There is no fork or second OAuth protocol
implementation.

A native-signed request carries a server-generated flow UUID. Its verification
record retains the canonical request, initiating global user (once known), grant
UUID, expiry and terminal state. The browser can select only its own effective
membership. Grant admission requires that tenant's current accepted SSO tuple;
another tenant's session or a shared email cannot supply it. Native SSO initiation
preserves the verified OAuth server context so the callback resumes the original
request. Selection, consent and code issuance recheck that binding under locks.

Each authorisation gets one immutable grant. Consent is required for each new
flow except a server-configured first-party bypass. Repeated selection, duplicate
consent, completed/denied flows, changed users and forged requests cannot create
another code. The browser renders registered application/resource details and
eligible memberships returned by the verified flow endpoint.

The retained authentication snapshot includes global user, membership, original
session, account, tenant, provider instance/revision, broker authentication time,
nullable verified upstream time and original session expiry. Database validation
rejects a snapshot that differs from the accepted tuple; the immutable grant
trigger prevents rewriting it.

Login-only grants require a client-only authorisation capability and assignment.
Service grants additionally require the exact client/resource capability and
assignment. Refresh requires a separate renewal capability for the same target;
login-only renewal therefore permits a null resource. Every code exchange and
refresh checks current authentication, effective membership, target eligibility,
original scope ceiling and current permissions before invoking native issuance.

The lock order remains subject/owner users (sorted), tenant, client, resource and
grant; current provider/account evidence is also locked. Client assertion
consumption occurs in autocommit before the issuance transaction and survives a
rejected grant. Native replay cleanup is confined to the immutable grant family;
intentional revocation barriers survive cleanup failures while ordinary issuance
failures roll back code/token/consent effects.

## Tokens, lifetime and revocation

Native ID tokens and resource access JWTs carry the global user subject and
matching tenant, membership, grant, client-instance and resource-instance claims.
The broker `auth_time` and nullable `upstream_auth_time` have distinct meanings.
Client and organisation authorisation versions reflect issuance-time policy.
The claims callback refuses a grant or client that differs from the decision
made under the grant's locks. Resource custom claims cannot replace those
identity fields. Login-only access tokens remain native opaque tokens; UserInfo
rechecks their retained grant.

Native resource TTLs remain bounded by the provider defaults. The retained grant
has an absolute 30-day default ceiling, so rotation cannot extend delegation
indefinitely. Five-minute upstream freshness remains confined to sensitive
commands and linking. Normal browsing and ordinary sign-out retain their
separate session/delegation behaviour. Explicit administrative revocation and
terminal deletion invalidate the relevant grants. Reinstatement cannot revive
revoked contexts.

The refresh reuse interval is 0 (`apps/id/src/auth.ts`): reusing an
already-rotated refresh token is a replay and revokes only that grant family. A
window for hosts that refresh in parallel is `Q-REFRESH-PARALLEL` in
[the plan](../docs/02-plan.md#open-register).

Refresh revocation closes a family; opaque access revocation removes that token.
Unknown and foreign tokens return empty success without crossing client/family
boundaries. Native self-contained JWT revocation is unsupported. Resource
servers must enforce expiry and their own current-authority contract.
