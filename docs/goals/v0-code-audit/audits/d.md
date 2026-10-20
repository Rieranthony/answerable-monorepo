# Audit D: mechanical baseline and consumer map (20 October 2026)

Worktree `/Users/anthonyriera/code/answerable/.claude/worktrees/agent-ad15a79a16f69849f`, commit 60c98f65, clean tree. No Postgres, no ID test suite. Raw outputs and the scripts that produced every table are in `/tmp/v0-code-audit/probes/d/` (numbered as below). This report records facts; it gives no delete or simplify verdicts. Every table row below comes from the command named in its section, except where a section says a row was resolved by reading the call site.

## 1. Scope and method: commands run

| # | Command (from the worktree root unless stated) | Headline |
|---|---|---|
| 0 | `bun install` | 1,927 packages; tree stayed clean |
| 1 | `bunx knip` (output `01-knip.txt`) | Exit 0, **no unused files, exports, types or dependencies in any workspace**; only 42 configuration hints (see section 2) |
| 2 | `bunx jscpd --config jscpd.json` (path list, ignore `**/*.test.ts`, `**/__tests__/**`, `minLines 8`; the CLI form in the brief was refused by the shell guard because of the glob, so the same options went into a config file, `jscpd.json`) | 37 clones, 445 duplicated lines (1.90% of 23,467 TypeScript lines), 165 files |
| 3 | `bunx tsc --noEmit --noUnusedLocals --noUnusedParameters` in `apps/id`, `packages/auth`, `packages/id-admin` (`03-*.txt`) | Exit 0 and empty output in all three: **0 unused locals or parameters** (apps/id's tsconfig includes `src/**/*.ts`, `src/**/*.tsx`, `scripts/**/*.ts`, `*.config.ts`; tests are included) |
| 4 | `04-smells.ts` over the non-test source of the three packages (166 files); matches in `04-smells-matches.tsv`, per-file counts in `04-smells-summary.txt` | See section 4 |
| 5 | `05-sizes.ts` (non-test lines in `apps/id/src`; `05-sizes.txt`) | 162 files, 22,998 lines |
| 6 | `06-routes.ts` imports `adminRouteTables` from `apps/id/src/http/admin/index.ts` and greps the consumer set; `06-final.ts` builds the table | 80 admin routes |
| 7 | `07-auth.ts` imports `publicAuthRoutes` and greps `apps/id/src` plus the consumer set | 16 allowed Better Auth routes |
| 8 | `08-env.ts` | 30 variables |
| 9 | `09-deps.ts` (one `npm view <name> version` per package) | 36 declared dependencies in three packages (17 runtime, 19 dev) |
| 10 | `10-actions.ts` imports `auditActions` from `apps/id/src/db/queries/audit.ts` | 66 actions |
| 11 | `11-support.ts` | 77 exports in 29 files of `apps/id/src/__tests__` |

## 2. Headline counts

| Item | Count |
|---|---|
| knip findings | 0 (the five docs-snippet false positives from the cleanup did not appear; I did not investigate why) |
| knip configuration hints | 42 (redundant or non-matching entry patterns in `knip.json`, for example `**/coverage/**`, `**/dist/**`, `**/.next/**`, `scripts/*.ts` at the root, `src/__tests__/preload.ts` in `apps/id`); they change no result |
| Duplicated blocks of 8+ lines | 37 (all 9 to 18 lines), 445 lines |
| Unused locals / parameters | 0 |
| `eslint-disable`, `@ts-ignore`, `@ts-expect-error`, `as any`, `as unknown as`, `any` annotations, TODO/FIXME/XXX/HACK | 0 each |
| Non-null assertions (`!`) | 259 in 64 files, of which 85 are `context.req.param("x")!` in the admin route modules |
| `console.` | 6 in 4 files (`runtime.ts` 3, `lib/log.ts` 1, `server.ts` 1, `operations/protocol-sweep.ts` 1) |
| Raw `sql` template uses | 187 in 43 files |
| `catch {` | 29 in 16 files; 5 with a comment-only body (swallowed) |
| Admin routes | 80 (32 read, 43 write, 5 erase; 58 platform tier, 22 tenant tier); 43 have no runtime caller; 31 have no caller of any kind except ID's own tests and, for 22 of them, a docs page |
| Better Auth allowlist routes | 16; 6 have no non-test caller in the repository: `/auth/jwks`, `/auth/oauth2/authorize`, `GET` and `POST /auth/oauth2/userinfo` and `/auth/oauth2/revoke` are reached through OAuth discovery by external clients, and `/auth/ok` by nothing (section 7) |
| Variables nothing in the chart, the kind stack or the deploy sets | 13 of 30, plus `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`, which the deploy writes only if the owner pastes them |
| Dependencies behind a major | 3 dev tools (`eslint`, `@eslint/js`, `typescript`) in each of the 3 packages = 9 rows; no runtime dependency. 15 of 17 runtime rows are behind a minor or patch; 2 are current |
| Audit actions with a writer and no reader in code | 38 of 66 (28 are read by the Toolbox poller by prefix) |
| Test-support exports imported by exactly one file | 10 of 77 |

## 3. Duplication (item 2)

Command 2. jscpd counts a block as a clone when 8+ lines and 50+ tokens repeat. Paths relative to `apps/id/src` (`packages/*` had none). Two thirds are the admin route modules' repeated handler shapes (the `const xId = context.req.param("xId")!` plus service call plus response block, and the repeated `routes` metadata blocks).

| Lines | Location A | Location B |
|---|---|---|
| 16 | `auth.ts:179-194` | `auth.ts:195-210` |
| 11 | `db/client-principal.ts:53-63` | `db/queries/grants.ts:66-76` |
| 13 | `db/queries/organizations.ts:194-206` | `db/queries/users.ts:254-263` |
| 11 | `db/schema/authorization.ts:207-217` | `db/schema/capabilities.ts:45-55` |
| 9 | `db/schema/oauth.ts:178-186` | `db/schema/oauth.ts:220-227` |
| 9 | `http/admin/capabilities.ts:238-246` | `http/admin/entitlements.ts:291-299` |
| 13 | `http/admin/capabilities.ts:279-291` | `http/admin/entitlements.ts:341-353` |
| 11 | `http/admin/clients.ts:437-447` | `http/admin/clients.ts:459-469` |
| 9 | `http/admin/clients.ts:499-507` | `http/admin/clients.ts:527-535` |
| 14 | `http/admin/domains.ts:115-128` | `http/admin/domains.ts:135-148` |
| 9 | `http/admin/domains.ts:154-162` | `http/admin/domains.ts:216-224` |
| 9 | `http/admin/domains.ts:154-162` | `http/admin/domains.ts:243-251` |
| 9 | `http/admin/domains.ts:193-201` | `http/admin/groups.ts:380-388` |
| 11 | `http/admin/domains.ts:217-227` | `http/admin/domains.ts:244-254` |
| 10 | `http/admin/entitlements.ts:19-28` | `http/admin/groups.ts:21-30` |
| 10 | `http/admin/entitlements.ts:19-28` | `http/admin/sessions.ts:8-17` |
| 18 | `http/admin/entitlements.ts:195-212` | `http/admin/entitlements.ts:219-236` |
| 14 | `http/admin/entitlements.ts:249-262` | `http/admin/groups.ts:352-365` |
| 12 | `http/admin/entitlements.ts:251-262` | `http/admin/sessions.ts:97-108` |
| 12 | `http/admin/entitlements.ts:375-386` | `http/admin/entitlements.ts:402-413` |
| 9 | `http/admin/entitlements.ts:375-383` | `http/admin/entitlements.ts:429-437` |
| 17 | `http/admin/entitlements.ts:386-402` | `http/admin/entitlements.ts:413-429` |
| 11 | `http/admin/groups.ts:132-142` | `http/admin/groups.ts:255-265` |
| 18 | `http/admin/groups.ts:183-200` | `http/admin/groups.ts:207-224` |
| 12 | `http/admin/groups.ts:448-459` | `http/admin/groups.ts:475-486` |
| 17 | `http/admin/groups.ts:459-475` | `http/admin/groups.ts:486-502` |
| 9 | `http/admin/members.ts:234-242` | `http/admin/members.ts:323-331` |
| 14 | `http/admin/organizations.ts:152-165` | `http/admin/organizations.ts:172-185` |
| 11 | `http/admin/organizations.ts:283-293` | `http/admin/organizations.ts:308-318` |
| 11 | `http/admin/resources.ts:321-331` | `http/admin/resources.ts:343-353` |
| 13 | `http/admin/sessions.ts:5-17` | `http/admin/users.ts:7-19` |
| 11 | `http/admin/sessions.ts:126-136` | `http/admin/users.ts:206-216` |
| 11 | `http/admin/sessions.ts:126-136` | `http/admin/users.ts:228-238` |
| 11 | `http/admin/sessions.ts:126-136` | `http/admin/users.ts:250-260` |
| 14 | `http/admin/users.ts:101-114` | `http/admin/users.ts:121-134` |
| 14 | `http/admin/users.ts:101-114` | `http/admin/users.ts:141-154` |
| 12 | `services/capabilities.ts:197-208` | `services/capabilities.ts:244-255` |

## 4. Smell greps (item 4)

Command 4; the regexes are in `04-smells.ts`. Comment lines are excluded except for the TODO and suppression patterns. Test files and `__tests__` are excluded. Zero results for: `eslint-disable`, `@ts-ignore`, `@ts-expect-error`, `as any`, `as unknown as`, `any` annotations (`: any`, `<any>`, `any[]`, `Record<string, any>`), `TODO|FIXME|XXX|HACK`.

**Non-null assertions, 259 in 64 files.** Largest: `packages/id-admin/src/testing.ts` 27 (the fake ID), `http/admin/groups.ts` 19, `bootstrap.ts` 14, `auth/verified-sso.ts` 11, `http/admin/clients.ts` 10, `http/admin/entitlements.ts` 10, `http/admin/members.ts` 8, `services/capabilities.ts` 8, `http/admin/domains.ts` 7. The full per-file list is in `04-smells-summary.txt`. 85 are `context.req.param("name")!`; the rest are `rows.at(-1)!`, `(await queries.setX(...))!` after a guarded update, `resource!.allowedScopes` and similar.

**`console.` (6).** `runtime.ts:40,43,66`, `lib/log.ts:11` (`console.error`, the structured logger), `server.ts:18`, `operations/protocol-sweep.ts:76`.

**Raw `sql` templates, 187 in 43 files.** `db/runtime-role.ts` 23, `db/schema/tenant-policies.ts` 18, `db/schema/authorization.ts` 13, `db/schema/auth.ts` 13, `db/schema/grant-contexts.ts` 12, `db/queries/organizations.ts` 9, `auth/create-resource-grant.ts` 8, `db/schema/capabilities.ts` 8, `db/schema/columns.ts` 8, `db/queries/users.ts` 7, `db/schema/oauth.ts` 7; 32 files have 1 to 4. Most of the schema-file uses are policies, checks and generated columns. Full list in `04-smells-summary.txt`.

**`catch {`, 29 in 16 files.** `services/sso-test.ts` 5, `http/pages/routes/login.ts` 4, `http/pages/routes/oauth.ts` 3, `http/pages/routes/security.ts` 2, `http/principal.ts` 2, `env.ts` 2, `packages/auth/src/index.ts` 2, one each in 9 more files. Context of each in `04-catch-context.txt` (the first 100 lines). Comment-only bodies, which swallow the error: `http/principal.ts:254` (malformed credentials stay anonymous), `http/pages/routes/oauth.ts:87` and `:112` (reload so the browser can retry), `http/pages/routes/login.ts:65` (unreachable service leaves the form) and `:152` (render with a retry message). The others return, set a message, record a problem or rethrow a typed error.

## 5. Module sizes (item 5)

Command 5: 162 files, 22,998 non-test lines (all `.ts`, `.tsx` and the one `.css`; `__tests__` and `*.test.ts` excluded; counts include blank lines and comments).

Ten largest:

| Lines | File |
|---|---|
| 631 | http/admin/groups.ts |
| 552 | http/admin/clients.ts |
| 517 | services/clients.ts |
| 453 | http/admin/entitlements.ts |
| 446 | auth/user-oauth-flow.ts |
| 432 | auth/member-permission.ts |
| 421 | auth/verified-sso.ts |
| 414 | auth/user-token-boundary.ts |
| 399 | http/principal.ts |
| 386 | http/admin/resources.ts |

Lines per directory:

| Lines | Directory |
|---|---|
| 5,362 | http/admin |
| 4,289 | auth |
| 3,732 | services |
| 3,595 | db/queries |
| 1,585 | db/schema |
| 1,365 | http (top level files) |
| 1,185 | http/pages |
| 1,106 | (src root: app.ts, auth.ts, bootstrap.ts, env.ts, runtime.ts, server.ts) |
| 487 | db (top level files) |
| 259 | operations |
| 33 | lib |

By top level: http 7,912, db 5,667, auth 4,289, services 3,732, root 1,106, operations 259, lib 33. The complete file list is in `05-sizes.txt`.

## 6. Admin route consumer map (item 6)

Command 6. The 80 routes, with method, path (under `/api/admin/v1`), operation id, `x-kind`, `x-tier`, the scopes (`platform` / `org`), and the fresh-authentication policy (`yes`, `no`, or `except <fields>`: the server-owned policy, `x-fresh-authentication`). Callers were grepped by path in the consumer set (`mcps/admin/src`, `mcps/toolbox/src`, `packages/id-admin/src`, `packages/acceptance/src`, `infra/ops/src`, `infra/k8s`, `apps/web/content/docs`, `scripts`, `.github/workflows`; `node_modules` and `apps/id` excluded), params replaced by a pattern for `${x}`, `$X`, `{x}`, `<x>`, `:x`.

Columns:

- **Runtime callers.** Resolved by reading each call site, with the method confirmed (the loose path grep cannot tell GET from PATCH on a shared path, so I read `mcps/admin/src`, `mcps/toolbox/src/{admin-enable,grants,poller}.ts`, `infra/ops/src/{register,make-admin,admin-api}.ts` and `infra/k8s/local/sign-in.ts`). Includes calls whose path is built at run time: `mcps/admin/src/organisations.ts:103` (`/disable` or `/enable` chosen by a ternary) and `mcps/admin/src/access.ts:217` (`${words.path}`). The Toolbox's own `/organisations/:id/enable` (British spelling) in `mcps/admin/src/toolbox.ts` is the Toolbox's API, not ID's, and is not counted.
- **Support callers.** Path-level grep hits in test files, the fake ID (`packages/id-admin/src/testing.ts`, `infra/ops/src/testing.ts`) and the acceptance kit (`kit`). The method was not checked, so a row can show a support caller of the same path with another method.
- **Docs.** Number of `.mdx` pages naming the path; the pages `id/onboard.mdx` and `id/manage.mdx` are hand-written prose and curl examples for staff and organisation IT admins, who are the human callers of the tenant-tier routes.

| Route | Operation | x-kind | x-tier | Scopes (platform / org) | Fresh auth | Runtime callers | Support callers (path-level) | Docs pages |
|---|---|---|---|---|---|---|---|---|
| GET `/organizations/:organizationId/capabilities` | listCapabilities | read | tenant | platform:read / org:read | no | Toolbox | acceptance (kit), acceptance | 5 |
| GET `/organizations/:organizationId/capabilities/:capabilityId` | getCapability | read | tenant | platform:read / org:read | no | none | none | 1 |
| POST `/organizations/:organizationId/capabilities` | createCapability | write | platform | platform:write | yes | Toolbox, ops Jobs | acceptance (kit), acceptance | 5 |
| PATCH `/organizations/:organizationId/capabilities/:capabilityId` | updateCapability | write | platform | platform:write | yes | none | none | 1 |
| DELETE `/organizations/:organizationId/capabilities/:capabilityId` | removeCapability | write | platform | platform:write | yes | none | none | 1 |
| GET `/operations/:operationId` | getOperationStatus | read | platform | platform:read | no | none | none | 1 |
| GET `/organizations/:organizationId/sign-in-diagnosis` | diagnoseSignIn | read | tenant | platform:read / org:users | no | none | none | 2 |
| GET `/me` | getAdminMe | read | tenant | (open) | no | admin MCP | admin, id-admin | 3 |
| GET `/users` | listUsers | read | platform | platform:read | no | none | none | 1 |
| GET `/users/:userId` | getUser | read | platform | platform:read | no | none | none | 2 |
| POST `/users/:userId/disable` | disableUser | write | platform | platform:users | yes | none | none | 2 |
| POST `/users/:userId/enable` | enableUser | write | platform | platform:users | yes | none | none | none |
| POST `/users/:userId/retire-email` | retireUserEmail | write | platform | platform:users | yes | none | none | 1 |
| DELETE `/users/:userId` | eraseUser | erase | platform | platform:write | yes | none | none | 2 |
| GET `/users/:userId/sessions` | listUserSessions | read | platform | platform:read | no | none | none | 1 |
| DELETE `/users/:userId/sessions` | revokeUserSessions | write | platform | platform:users | yes | none | none | 1 |
| DELETE `/users/:userId/sessions/:sessionId` | revokeUserSession | write | platform | platform:users | yes | none | none | none |
| GET `/entitlements` | listAllEntitlements | read | platform | platform:read | no | none | toolbox, id-admin, ops | 1 |
| GET `/organizations/:organizationId/entitlements` | listEntitlements | read | tenant | platform:read / org:read | no | admin MCP, Toolbox | admin, id-admin, acceptance (kit), acceptance | 6 |
| POST `/organizations/:organizationId/entitlements` | createEntitlement | write | platform | platform:write | yes | admin MCP, Toolbox, ops Jobs | admin, id-admin, acceptance (kit), acceptance | 6 |
| GET `/organizations/:organizationId/entitlements/:entitlementId` | getEntitlement | read | tenant | platform:read / org:read | no | admin MCP | none | 1 |
| PATCH `/organizations/:organizationId/entitlements/:entitlementId` | updateEntitlement | write | platform | platform:write | yes | none | none | 1 |
| POST `/organizations/:organizationId/entitlements/:entitlementId/disable` | disableEntitlement | write | platform | platform:write | yes | admin MCP | admin | none |
| POST `/organizations/:organizationId/entitlements/:entitlementId/enable` | enableEntitlement | write | platform | platform:write | yes | admin MCP | admin | none |
| DELETE `/organizations/:organizationId/entitlements/:entitlementId` | removeEntitlement | write | platform | platform:write | yes | none | none | 1 |
| GET `/organizations/:organizationId/members/:memberId/access` | getMemberAccess | read | tenant | platform:read / org:users | no | admin MCP, Toolbox | admin, id-admin | 2 |
| GET `/organizations/:organizationId/access` | listTargetAccess | read | tenant | platform:read / org:read | no | admin MCP | admin | 2 |
| GET `/organizations/:organizationId/groups` | listGroups | read | tenant | platform:read / org:read | no | admin MCP, ops Jobs | admin, acceptance (kit), k8s | 3 |
| POST `/organizations/:organizationId/groups` | createGroup | write | platform | platform:write | yes | admin MCP, ops Jobs | admin, acceptance (kit), k8s | 3 |
| GET `/organizations/:organizationId/groups/:groupId` | getGroup | read | tenant | platform:read / org:read | no | admin MCP | none | 1 |
| PATCH `/organizations/:organizationId/groups/:groupId` | updateGroup | write | platform | platform:write | except name | none | none | 1 |
| POST `/organizations/:organizationId/groups/:groupId/disable` | disableGroup | write | platform | platform:write | yes | none | none | none |
| POST `/organizations/:organizationId/groups/:groupId/enable` | enableGroup | write | platform | platform:write | yes | none | none | none |
| DELETE `/organizations/:organizationId/groups/:groupId` | eraseGroup | erase | platform | platform:write | yes | none | none | 1 |
| GET `/organizations/:organizationId/groups/:groupId/members` | listGroupMembers | read | tenant | platform:read / org:read | no | none | acceptance | 1 |
| GET `/organizations/:organizationId/groups/:groupId/members/:memberId` | getGroupMember | read | tenant | platform:read / org:read | no | admin MCP | admin, id-admin, acceptance, ops | 3 |
| PUT `/organizations/:organizationId/groups/:groupId/members/:memberId` | putGroupMember | write | platform | platform:write | yes | admin MCP, ops Jobs, kind sign-in | admin, id-admin, acceptance, ops | 3 |
| DELETE `/organizations/:organizationId/groups/:groupId/members/:memberId` | removeGroupMember | write | platform | platform:write | yes | admin MCP | admin, id-admin, acceptance, ops | 3 |
| GET `/organizations/:organizationId/members/:memberId/configuration` | getMemberConfiguration | read | tenant | platform:users / org:users | no | none | none | 1 |
| GET `/organizations/:organizationId/members` | listMembers | read | tenant | platform:read / org:read | no | admin MCP, ops Jobs | admin, id-admin, ops | 3 |
| GET `/organizations/:organizationId/members/:memberId` | getMember | read | tenant | platform:read / org:read | no | admin MCP | admin | 1 |
| PATCH `/organizations/:organizationId/members/:memberId` | updateMember | write | tenant | platform:users / org:users | yes | none | admin | 1 |
| POST `/organizations/:organizationId/members/:memberId/reinstate` | reinstateMember | write | tenant | platform:users / org:users | yes | none | none | 1 |
| DELETE `/organizations/:organizationId/members/:memberId` | removeMember | write | tenant | platform:users / org:users | yes | none | admin | 1 |
| GET `/resources` | listResources | read | platform | platform:read | no | none | id-admin, acceptance (kit), ops | 5 |
| POST `/resources` | createResource | write | platform | platform:write | yes | ops Jobs | id-admin, acceptance (kit), ops | 5 |
| GET `/resources/:resource` | getResource | read | platform | platform:read | no | Toolbox | toolbox, id-admin, acceptance | 2 |
| PATCH `/resources/:resource` | updateResource | write | platform | platform:write | except name | Toolbox | toolbox, id-admin, acceptance | 2 |
| POST `/resources/:resource/disable` | disableResource | write | platform | platform:write | yes | none | none | none |
| POST `/resources/:resource/enable` | enableResource | write | platform | platform:write | yes | none | none | none |
| DELETE `/resources/:resource` | eraseResource | erase | platform | platform:write | yes | none | toolbox, id-admin, acceptance | 2 |
| DELETE `/clients/:clientId` | eraseClient | erase | platform | platform:write | yes | none | id-admin | 2 |
| GET `/clients` | listClients | read | platform | platform:read | no | none | id-admin, acceptance (kit), ops | 4 |
| POST `/clients` | createClient | write | platform | platform:write | yes | ops Jobs | id-admin, acceptance (kit), ops | 4 |
| GET `/clients/:clientId` | getClient | read | platform | platform:read | no | admin MCP | id-admin | 2 |
| PATCH `/clients/:clientId` | updateClient | write | platform | platform:write | except name,uri | none | id-admin | 2 |
| POST `/clients/:clientId/disable` | disableClient | write | platform | platform:write | yes | none | none | 1 |
| POST `/clients/:clientId/enable` | enableClient | write | platform | platform:write | yes | none | none | none |
| POST `/clients/:clientId/rotate-secret` | rotateClientSecret | write | platform | platform:write | yes | ops Jobs | none | 1 |
| PUT `/clients/:clientId/resources/:resource` | linkClientResource | write | platform | platform:write | yes | Toolbox, ops Jobs | toolbox, acceptance (kit) | 4 |
| DELETE `/clients/:clientId/resources/:resource` | unlinkClientResource | write | platform | platform:write | yes | none | toolbox, acceptance (kit) | 4 |
| DELETE `/organizations/:organizationId/domains/:domainId` | deleteOrganizationDomain | write | platform | platform:write | yes | none | none | 1 |
| GET `/organizations/:organizationId/domains` | listOrganizationDomains | read | tenant | platform:read / org:read | no | admin MCP, ops Jobs | admin, acceptance (kit), acceptance, ops, k8s | 2 |
| POST `/organizations/:organizationId/domains` | createOrganizationDomain | write | platform | platform:write | yes | admin MCP, ops Jobs | admin, acceptance (kit), acceptance, ops, k8s | 2 |
| POST `/organizations/:organizationId/domains/:domainId/disable` | disableOrganizationDomain | write | platform | platform:write | yes | none | none | none |
| POST `/organizations/:organizationId/domains/:domainId/enable` | enableOrganizationDomain | write | platform | platform:write | yes | none | none | none |
| GET `/organizations/:organizationId/sso-provider/test` | testSsoProvider | read | platform | platform:read | no | admin MCP, ops Jobs | admin, ops | 1 |
| GET `/organizations/:organizationId/sso-provider` | getSsoProvider | read | tenant | platform:read / org:read | no | admin MCP, ops Jobs | admin, id-admin, acceptance (kit), acceptance, ops | 2 |
| PUT `/organizations/:organizationId/sso-provider` | putSsoProvider | write | platform | platform:write | yes | admin MCP, ops Jobs | admin, id-admin, acceptance (kit), acceptance, ops | 2 |
| DELETE `/organizations/:organizationId/sso-provider` | deleteSsoProvider | write | platform | platform:write | yes | none | admin, id-admin, acceptance (kit), acceptance, ops | 2 |
| GET `/organizations` | listOrganizations | read | platform | platform:read | no | admin MCP, ops Jobs | admin, toolbox, id-admin, acceptance (kit), acceptance, ops, k8s | 2 |
| POST `/organizations` | createOrganization | write | platform | platform:write | yes | admin MCP | admin, toolbox, id-admin, acceptance (kit), acceptance, ops, k8s | 2 |
| GET `/organizations/:organizationId` | getOrganization | read | tenant | platform:read / org:read | no | admin MCP | admin, toolbox, id-admin, acceptance (kit), acceptance, ops | 2 |
| PATCH `/organizations/:organizationId` | updateOrganization | write | platform | platform:write | no | admin MCP | admin, toolbox, id-admin, acceptance (kit), acceptance, ops | 2 |
| POST `/organizations/:organizationId/disable` | disableOrganization | write | platform | platform:write | yes | admin MCP | admin, acceptance | 1 |
| POST `/organizations/:organizationId/enable` | enableOrganization | write | platform | platform:write | yes | admin MCP | admin | none |
| DELETE `/organizations/:organizationId` | eraseOrganization | erase | platform | platform:write | yes | none | admin, toolbox, id-admin, acceptance (kit), acceptance, ops | 2 |
| GET `/users/:userId/audit-events` | listUserAuditEvents | read | platform | platform:read | no | none | none | 1 |
| GET `/audit-events` | listAuditEvents | read | platform | platform:read | no | admin MCP, Toolbox | admin, toolbox, id-admin, acceptance, k8s | 3 |
| GET `/organizations/:organizationId/audit-events` | listOrganizationAuditEvents | read | tenant | platform:read / org:read | no | none | none | 1 |

**Routes with no runtime caller (43)**, list in `06-no-runtime-caller.txt`. Of these, **31 have no caller of any kind outside ID's own tests** (no fake, no acceptance, no ops, no MCP); 9 of those 31 are not even named in the docs: `POST /users/:userId/enable`, `DELETE /users/:userId/sessions/:sessionId`, `POST .../groups/:groupId/{disable,enable}`, `POST /resources/:resource/{disable,enable}`, `POST /clients/:clientId/enable`, `POST .../domains/:domainId/{disable,enable}`. Whole families with no runtime caller: all 9 `/users/*` routes (and `/users/:userId/audit-events`), `/operations/:operationId`, `sign-in-diagnosis`, `members/:id/configuration`, `GET|PATCH|DELETE capabilities/:capabilityId`, group, resource, client and domain enable/disable.

Not a verdict: the tenant-tier routes (`x-tier: tenant`) exist for organisation IT admins calling with their own token (docs `id/manage.mdx`), and the staff-tier user routes for support staff by curl (docs `id/onboard.mdx`); a missing machine caller is not a missing consumer. The coordinator and the route-surface auditors decide.

## 7. Better Auth route map (item 7)

Command 7 (`07-auth.ts`). `apps/id/src/http/auth-allowlist.ts` allows 16 method plus path pairs; the pages call them in-process through `callAuth` in `http/pages/gateway.ts`, which refuses any pair not in the list (`gateway.ts:17`). Columns: files in `apps/id/src` (non-test) naming the path, other repository workspaces naming it (non-test), docs pages naming it, test files naming it (all workspaces).

| Route | Operation | Tag | In apps/id/src (non-test) | Other workspaces (non-test) | Docs pages | Test files |
|---|---|---|---|---|---|---|
| GET `/auth/jwks` | getJwks | Token | none | none | 1 | 0 |
| GET `/auth/oauth2/authorize` | authorizeOAuth | Token | none | none | 2 | 3 |
| POST `/auth/oauth2/flow` | readOAuthFlow | Token | id/src/auth/user-oauth-flow.ts(1), id/src/http/pages/routes/oauth.ts(1) | none | 0 | 2 |
| POST `/auth/oauth2/continue` | continueOAuthFlow | Token | id/src/http/pages/routes/oauth.ts(1) | none | 0 | 3 |
| POST `/auth/oauth2/consent` | consentOAuth | Token | id/src/http/pages/routes/oauth.ts(1) | none | 0 | 3 |
| GET `/auth/oauth2/userinfo` | getUserInfo | Token | none | none | 1 | 1 |
| POST `/auth/oauth2/userinfo` | postUserInfo | Token | none | none | 1 | 1 |
| POST `/auth/oauth2/revoke` | revokeOAuthToken | Token | none | none | 1 | 0 |
| POST `/auth/sso/reauthenticate` | reauthenticateSso | Sign-in | id/src/auth/fresh-authentication.ts(1), id/src/http/pages/routes/security.ts(1) | none | 2 | 2 |
| POST `/auth/sso/link` | linkSso | Sign-in | id/src/http/pages/routes/security.ts(1) | none | 1 | 2 |
| POST `/auth/oauth2/token` | issueToken | Token | id/src/app.ts(1), id/src/operations/metrics.ts(1) | id-admin/src/index.ts(1) | 6 | 21 |
| GET `/auth/ok` | ok | Session | none | none | 0 | 5 |
| POST `/auth/sign-in/sso` | signInWithSso | Sign-in | id/src/http/pages/routes/login.ts(1) | none | 1 | 6 |
| GET `/auth/sso/callback` | ssoCallback | Sign-in | id/src/http/signin-audit.ts(1) | none | 2 | 3 |
| GET `/auth/get-session` | getSession | Session | id/src/http/pages/routes/login.ts(1), id/src/http/pages/routes/security.ts(1) | none | 1 | 10 |
| POST `/auth/sign-out` | signOut | Session | id/src/http/pages/routes/login.ts(1) | none | 1 | 6 |

Reading the call sites for the rows that look unused:

- **`GET /auth/jwks`, `GET /auth/oauth2/authorize`, `GET|POST /auth/oauth2/userinfo`, `POST /auth/oauth2/revoke`**: no in-repo caller by path. Clients reach them through the OAuth discovery document (`apps/id/src/http/oauth-metadata.ts`; `packages/auth/src/index.ts:121-124` reads `jwks_uri` from metadata and requires the same origin as the issuer, and ID's own `principal.ts:129` builds a local JWKS set in-process). `userinfo` is also named in `auth/user-token-assertions.ts:127` as a token audience, not a call.
- **`GET /auth/ok`**: named only in the allowlist and in 5 test files. The chart's probes and the Dockerfile do not use it (`grep auth/ok` over `charts`, `infra`, `apps/id/Dockerfile`, `docker-compose.yml` found only the allowlist). The service's own readiness routes are in `app.ts` (`status: "ok"` at lines 131 and 157).
- **`POST /auth/oauth2/flow|continue|consent`, `POST /auth/sso/reauthenticate|link`, `POST /auth/sign-in/sso`, `GET /auth/get-session`, `POST /auth/sign-out`**: called by the pages (`http/pages/routes/{login,oauth,security}.ts`) and, for `flow` and `reauthenticate`, by `auth/user-oauth-flow.ts` and `auth/fresh-authentication.ts`.
- **`GET /auth/sso/callback`**: Better Auth redirect target; named in `http/signin-audit.ts`.

## 8. Environment variables (item 8)

Command 8 (`08-env.ts`). 30 variables in `apps/id/src/env.ts`'s `environmentSchema`. A `yes` in a column means the variable's name appears in that file set; the last column lists other non-test files naming it. Columns `.env.example`, `default.env` and `workflows` are literal name matches. The deployed values are set in three ways, read from `charts/answerable/templates/id.yaml` and `infra/pipeline/src/deploy.ts`: literal `env:` entries in the chart's `answerable.idEnv` helper (`BETTER_AUTH_URL`, `BETTER_AUTH_TRUSTED_ORIGINS`, `TRUSTED_PROXY_CIDRS`, `PLATFORM_ORGANIZATION_SLUG`, `PLATFORM_ORGANIZATION_NAME`, `DATABASE_URL` from Secret `id-database`), the Secret `id-env` mounted with `envFrom` and written by `infra/pipeline/src/deploy.ts` from the GitHub environment (`BETTER_AUTH_SECRET`, `UPSTREAM_TOKEN_SECRETS`, `ROOT_ADMIN_SECRET` required; `MICROSOFT_*`, `GOOGLE_*` pairs and `BETTER_AUTH_SECRETS` optional), and the image (`apps/id/Dockerfile` names `NODE_ENV` and `PORT`). The `workflows` column is therefore mostly the variable being passed to the deploy step; the secrets themselves are named in `deploy.ts`, not in the workflow files.

| Variable | camelCase reader | Readers in apps/id/src (files) | values.yaml | values-*.yaml | templates/** | stack.ts | .env.example | default.env | workflows | Other places naming it |
|---|---|---|---|---|---|---|---|---|---|---|
| NODE_ENV | nodeEnv | 3: app.ts, runtime.ts, db/client.ts | - | - | - | - | yes | yes | yes | ops/Dockerfile, apps/id/Dockerfile |
| PORT | port | 1: runtime.ts | - | - | - | - | - | yes | - | apps/id/Dockerfile |
| DATABASE_URL | databaseUrl | 1: db/client.ts | - | - | yes | - | yes | yes | - | ops/README.md, ops/src/secret-store.ts, ops/src/bootstrap.ts |
| BETTER_AUTH_URL | betterAuthUrl | 5: app.ts, http/openapi.ts, http/pages/gateway.ts, http/principal.ts, ... | - | - | yes | - | yes | yes | - | - |
| BETTER_AUTH_SECRET | betterAuthSecret | 1: auth.ts | - | - | yes | yes | yes | yes | yes | pipeline/README.md, pipeline/src/cli.ts, pipeline/src/deploy.ts |
| BETTER_AUTH_SECRETS | betterAuthSecrets | 1: auth.ts | - | - | - | - | yes | yes | - | pipeline/README.md, pipeline/src/cli.ts, pipeline/src/deploy.ts |
| GOOGLE_CLIENT_ID | platformApplications | 6: auth/database-adapter.ts, auth/platform-applications.ts, runtime.ts, http/admin/sso-providers.ts, ... | - | - | - | - | yes | yes | yes | pipeline/README.md, pipeline/src/cli.ts, pipeline/src/deploy.ts |
| GOOGLE_CLIENT_SECRET | platformApplications | 6: auth/database-adapter.ts, auth/platform-applications.ts, runtime.ts, http/admin/sso-providers.ts, ... | - | - | - | - | yes | yes | yes | pipeline/README.md, pipeline/src/cli.ts, pipeline/src/deploy.ts |
| MICROSOFT_CLIENT_ID | platformApplications | 6: auth/database-adapter.ts, auth/platform-applications.ts, runtime.ts, http/admin/sso-providers.ts, ... | yes | - | - | - | yes | yes | yes | ops/src/register.ts, pipeline/README.md, pipeline/src/cli.ts, pipeline/src/deploy.ts, civo/README.md |
| MICROSOFT_CLIENT_SECRET | platformApplications | 6: auth/database-adapter.ts, auth/platform-applications.ts, runtime.ts, http/admin/sso-providers.ts, ... | yes | - | - | - | yes | yes | yes | ops/src/register.ts, pipeline/README.md, pipeline/src/cli.ts, pipeline/src/deploy.ts, civo/README.md |
| UPSTREAM_TOKEN_SECRETS | upstreamTokenSecrets | 2: operations/preflight.ts, auth.ts | - | - | yes | yes | yes | yes | yes | pipeline/README.md, pipeline/src/cli.ts, pipeline/src/deploy.ts |
| BETTER_AUTH_TRUSTED_ORIGINS | trustedOrigins | 5: app.ts, http/admin/sso-providers.ts, http/principal.ts, services/sso-test.ts, ... | yes | - | yes | - | yes | yes | - | - |
| PLATFORM_ORGANIZATION_SLUG | platformOrganizationSlug | 2: runtime.ts, bootstrap.ts | - | - | yes | - | yes | yes | - | ops/src/make-admin.ts, ops/src/register.ts |
| PLATFORM_ORGANIZATION_NAME | platformOrganizationName | 2: runtime.ts, bootstrap.ts | - | - | yes | - | yes | yes | - | - |
| ADMIN_RESOURCE_IDENTIFIER | adminResourceIdentifier | 4: runtime.ts, http/principal.ts, services/command-authority.ts, bootstrap.ts | - | - | - | - | yes | yes | - | - |
| ROOT_ADMIN_SECRET | rootAdminSecret | 2: http/principal.ts, services/command-authority.ts | - | - | yes | yes | yes | yes | yes | ops/README.md, ops/src/make-admin.ts, pipeline/README.md, pipeline/src/cli.ts, pipeline/src/deploy.ts |
| ROOT_ADMIN_BREAK_GLASS | rootAdminBreakGlass | 2: http/principal.ts, services/command-authority.ts | - | - | - | - | yes | yes | - | ops/README.md, ops/src/testing.ts, ops/src/make-admin.ts |
| TRUSTED_PROXY_CIDRS | trustedProxyCidrs | 1: auth.ts | yes | - | yes | - | yes | yes | - | civo/tests/production.tftest.hcl, civo/tests/staging.tftest.hcl, civo/modules/platform/outputs.tf, civo/modules/platform/main.tf, civo/modules/platform/tests/platform.tftest.hcl, civo/modules/platform/README.md |
| OAUTH_REFRESH_REUSE_INTERVAL_SECONDS | oauthRefreshReuseIntervalSeconds | 1: auth.ts | - | - | - | - | yes | yes | - | - |
| OPERATIONAL_LOG_INTERVAL_MS | operationalLogIntervalMs | 1: runtime.ts | - | - | - | - | yes | yes | - | - |
| PROTOCOL_SWEEP_INTERVAL_MS | protocolSweepIntervalMs | 1: runtime.ts | - | - | - | - | yes | yes | - | - |
| PROTOCOL_SWEEP_BATCH | protocolSweepBatchSize | 1: runtime.ts | - | - | - | - | yes | yes | - | - |
| DATABASE_POOL_MAX | databasePoolMax | 1: db/client.ts | - | - | - | - | yes | yes | - | - |
| DATABASE_POOL_IDLE_TIMEOUT_MS | databasePoolIdleTimeoutMs | 1: db/client.ts | - | - | - | - | yes | yes | - | - |
| DATABASE_STATEMENT_TIMEOUT_MS | databaseStatementTimeoutMs | 1: db/client.ts | - | - | - | - | yes | yes | - | - |
| DATABASE_LOCK_TIMEOUT_MS | databaseLockTimeoutMs | 1: db/client.ts | - | - | - | - | yes | yes | - | - |
| DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS | databaseIdleInTransactionTimeoutMs | 1: db/client.ts | - | - | - | - | yes | yes | - | - |
| DATABASE_CONNECTION_TIMEOUT_MS | databaseConnectionTimeoutMs | 1: db/client.ts | - | - | - | - | yes | yes | - | - |
| OPENAPI_ENABLED | openApiEnabled | 1: app.ts | - | - | - | - | yes | yes | - | - |

**Nothing in the chart, the kind stack or the deploy sets these 13** (they take their defaults in every environment; each is in `default.env` and `.env.example` and documented in `apps/id/OPERATIONS.md` and `apps/id/README.md`): `ADMIN_RESOURCE_IDENTIFIER` (defaults to `<BETTER_AUTH_URL>/api/admin`), `ROOT_ADMIN_BREAK_GLASS` (named in `infra/ops/src/make-admin.ts:54,58` as a thing that must stay unset, set by no template), `OAUTH_REFRESH_REUSE_INTERVAL_SECONDS`, `OPERATIONAL_LOG_INTERVAL_MS`, `PROTOCOL_SWEEP_INTERVAL_MS`, `PROTOCOL_SWEEP_BATCH`, `DATABASE_POOL_MAX`, `DATABASE_POOL_IDLE_TIMEOUT_MS`, `DATABASE_STATEMENT_TIMEOUT_MS`, `DATABASE_LOCK_TIMEOUT_MS`, `DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS`, `DATABASE_CONNECTION_TIMEOUT_MS`, `OPENAPI_ENABLED`. `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are set only if the owner pastes the pair into the GitHub environment (`deploy.ts` writes both or neither). `NODE_ENV` and `PORT` are set by `apps/id/Dockerfile:38-39` only.

Each variable has exactly one reader module except the groups below: the six `DATABASE_*` timeouts and pool settings are read only in `db/client.ts`; the four platform-application variables become `platformApplications`, read in 6 files; `BETTER_AUTH_URL`, `BETTER_AUTH_TRUSTED_ORIGINS` and `ADMIN_RESOURCE_IDENTIFIER` are read in 4 to 5 files each.

## 9. Dependencies (item 9)

Command 9 (`09-deps.ts`). Importing files = files in the package (excluding `node_modules`, `coverage`, `drizzle`) with an `import` / `from` / `require` of the package name or a subpath, split into non-test and test files. Installed = the version in the workspace's or the root's `node_modules`; latest = `npm view <name> version` on 20 October 2026. "MAJOR" = the latest major differs.

| Package | Kind | Name | Declared | Installed | Latest | Status | Non-test importers | Test importers | First importers |
|---|---|---|---|---|---|---|---|---|---|
| apps/id | dep | @better-auth/core | 1.7.2 | 1.7.2 | 1.7.11 | behind | 7 | 0 | src/auth/native-client-authentication.ts, src/auth/database-adapter.ts, src/auth/user-token-boundary.ts, ... |
| apps/id | dep | @better-auth/drizzle-adapter | 1.7.2 | 1.7.2 | 1.7.11 | behind | 1 | 0 | src/auth/database-adapter.ts |
| apps/id | dep | @better-auth/oauth-provider | 1.7.2 | 1.7.2 | 1.7.11 | behind | 9 | 2 | src/auth/native-client-authentication.ts, src/auth/user-token-assertions.ts, src/auth/machine-provider.ts, ... |
| apps/id | dep | @better-auth/sso | 1.7.2 | 1.7.2 | 1.7.11 | behind | 4 | 1 | src/auth/verified-sso.ts, src/auth/sso-origin.ts, src/services/federation.ts, ... |
| apps/id | dep | @hono/standard-validator | 0.2.2 | 0.2.2 | 0.4.0 | behind | 0 | 0 |  |
| apps/id | dep | better-auth | 1.7.2 | 1.7.2 | 1.7.11 | behind | 23 | 8 | src/auth/answerable-schema.ts, src/auth/native-client-authentication.ts, src/auth/database-adapter.ts, ... |
| apps/id | dep | drizzle-orm | 0.45.2 | 0.45.2 | 0.45.4 | behind | 64 | 101 | scripts/migrate.ts, scripts/test-migrations.ts, src/auth/user-resource-policy.ts, ... |
| apps/id | dep | hono | 4.13.5 | 4.13.5 | 4.13.13 | behind | 38 | 8 | src/app.ts, src/http/validation.ts, src/http/admin/resources.ts, ... |
| apps/id | dep | hono-openapi | 1.3.1 | 1.3.1 | 1.5.0 | behind | 7 | 4 | src/app.ts, src/http/validation.ts, src/http/admin/schemas.ts, ... |
| apps/id | dep | hono-tailwind | 3.0.1 | 3.0.1 | 3.0.1 | current | 2 | 0 | scripts/build-css.ts, src/http/pages/index.ts |
| apps/id | dep | jose | 6.2.10 | 6.2.10 | 6.2.13 | behind | 4 | 13 | src/auth/user-token-assertions.ts, src/auth/machine-audit.ts, src/operations/preflight.ts, ... |
| apps/id | dep | pg | 8.16.3 | 8.16.3 | 8.23.1 | behind | 5 | 2 | scripts/migrate.ts, scripts/test-migrations.ts, src/auth/database-adapter.ts, ... |
| apps/id | dep | tailwindcss | 4.3.3 | 4.3.3 | 4.3.3 | current | 0 | 0 |  |
| apps/id | dep | zod | 4.5.4 | 4.5.4 | 4.6.7 | behind | 37 | 2 | scripts/migrate.ts, scripts/stack-directories.ts, scripts/mcp-e2e-fixture.ts, ... |
| apps/id | dev | @answerable/auth | workspace:* | 0.6.0 | workspace |  | 0 | 1 |  |
| apps/id | dev | @answerable/ui | workspace:* | 0.0.0 | workspace |  | 6 | 0 | src/http/pages/ui/logo.tsx, src/http/pages/ui/button.tsx, src/http/pages/ui/input.tsx, ... |
| apps/id | dev | @eslint/js | 9.39.5 | 9.39.5 | 10.0.1 | MAJOR | 1 | 0 | eslint.config.mjs |
| apps/id | dev | @types/bun | 1.3.1 | 1.3.1 | 1.4.3 | behind | 0 | 0 |  |
| apps/id | dev | @types/pg | 8.15.6 | 8.15.6 | 8.23.1 | behind | 0 | 0 |  |
| apps/id | dev | drizzle-kit | 0.31.10 | 0.31.10 | 0.31.11 | behind | 1 | 2 | drizzle.config.ts |
| apps/id | dev | eslint | 9.39.5 | 9.39.5 | 10.13.0 | MAJOR | 0 | 0 |  |
| apps/id | dev | typescript | 5.9.3 | 5.9.3 | 7.0.2 | MAJOR | 0 | 0 |  |
| apps/id | dev | typescript-eslint | 8.48.1 | 8.48.1 | 8.72.0 | behind | 1 | 0 | eslint.config.mjs |
| packages/auth | dep | jose | 6.2.12 | 6.2.12 | 6.2.13 | behind | 2 | 1 | src/testing.ts, src/index.ts |
| packages/auth | dep | zod | 4.6.5 | 4.6.5 | 4.6.7 | behind | 1 | 0 | src/index.ts |
| packages/auth | dev | @eslint/js | 9.39.5 | 9.39.5 | 10.0.1 | MAJOR | 1 | 0 | eslint.config.mjs |
| packages/auth | dev | @types/bun | 1.3.1 | 1.3.1 | 1.4.3 | behind | 0 | 0 |  |
| packages/auth | dev | eslint | 9.39.5 | 9.39.5 | 10.13.0 | MAJOR | 0 | 0 |  |
| packages/auth | dev | typescript | 5.9.3 | 5.9.3 | 7.0.2 | MAJOR | 0 | 0 |  |
| packages/auth | dev | typescript-eslint | 8.48.1 | 8.48.1 | 8.72.0 | behind | 1 | 0 | eslint.config.mjs |
| packages/id-admin | dep | zod | 4.6.5 | 4.6.5 | 4.6.7 | behind | 1 | 1 | src/index.ts |
| packages/id-admin | dev | @eslint/js | 9.39.5 | 9.39.5 | 10.0.1 | MAJOR | 1 | 0 | eslint.config.mjs |
| packages/id-admin | dev | @types/bun | 1.3.1 | 1.3.1 | 1.4.3 | behind | 0 | 0 |  |
| packages/id-admin | dev | eslint | 9.39.5 | 9.39.5 | 10.13.0 | MAJOR | 0 | 0 |  |
| packages/id-admin | dev | typescript | 5.9.3 | 5.9.3 | 7.0.2 | MAJOR | 0 | 0 |  |
| packages/id-admin | dev | typescript-eslint | 8.48.1 | 8.48.1 | 8.72.0 | behind | 1 | 0 | eslint.config.mjs |

Notes:

- **Majors behind:** `eslint` 9.39.5 to 10.13.0, `@eslint/js` 9.39.5 to 10.0.1 and `typescript` 5.9.3 to 7.0.2, in all three packages (dev tools only). No runtime dependency is a major behind. `@hono/standard-validator` 0.2.2 to 0.4.0 is a 0.x minor, outside `hono-openapi` 1.3.1's peer range (`^0.2.0`, `node_modules/hono-openapi/package.json:44`); `hono-openapi` 1.5.0 is the matching bump.
- **Zero importers, still needed:** `@hono/standard-validator` (imported by `hono-openapi/dist/index.js:2`, an optional peer), `tailwindcss` (loaded by `hono-tailwind`'s `buildCss` and `@import` in `src/http/pages/styles.css`), `@types/bun` and `@types/pg` (ambient types), `eslint` and `typescript` (run as tools), `@answerable/auth` in `apps/id` (one test, `auth/user-oauth.integration.test.ts`; it is a dev dependency, correct).
- **Version skew inside the monorepo:** `apps/id` pins `zod` 4.5.4 and `jose` 6.2.10, `packages/auth` and `packages/id-admin` pin `zod` 4.6.5 and (auth) `jose` 6.2.12; the latest are 4.6.7 and 6.2.13.
- **The Better Auth family** (`better-auth` and four `@better-auth/*` packages, all in `apps/id`) is at 1.7.2; latest is 1.7.11 (the brief and AGENTS.md name 1.7.2 as the audited version).
- `@better-auth/oauth-provider`, `@better-auth/sso`, `@better-auth/drizzle-adapter` and `@better-auth/core` are all imported by non-test source.

## 10. Audit action vocabulary (item 10)

Command 10. The list is `auditActions` in `apps/id/src/db/queries/audit.ts:15-82` (the brief named `db/schema/vocabulary.ts`, which holds only actor types and outcomes; `action` is a free `text` column, kept honest by a test that compares the list with the table in `docs/04-answerable-id-schema.md`). 66 actions.

Columns: **Writer** = non-test files in `apps/id/src` or `apps/id/drizzle` that contain the action as a quoted string (`drizzle/0001_invariants.sql` is where the audit triggers are; a match there means the name appears in a trigger or a check, so it may be a writer or a list); `(not literal)` = built at run time (`statusAction()` in `services/audit.ts:14` builds `domain|entitlement|group.enabled|disabled`). **ID tests** = test files that name it. **Code readers** = non-test files outside `apps/id` (`mcps/*/src`, `packages/*/src`, `infra`, `scripts`) naming it. **Test readers** = test files there. **Docs** = `apps/web/content/docs` pages. **Design docs** = `docs/` and `apps/id` markdown (outside `docs/goals`).

| Action | Writer | ID tests | Code readers | Test readers | Docs | Design docs |
|---|---|---|---|---|---|---|
| admin.auth_failed | src/http/principal.ts | 1 | none | none | none | docs/04-answerable-id-schema.md |
| admin.denied | src/http/authorize.ts | 4 | none | none | none | docs/04-answerable-id-schema.md |
| admin.root_request | src/http/authorize.ts, src/http/principal.ts | 4 | infra/README.md | none | id/onboard.mdx | docs/04-answerable-id-schema.md |
| auth.signin.rejected | src/http/signin-audit.ts | 3 | none | none | none | docs/04-answerable-id-schema.md |
| auth.signin.succeeded | src/auth/sso-origin.ts | 4 | none | none | id/manage.mdx | docs/04-answerable-id-schema.md |
| auth.signout | src/auth/audit-hooks.ts | 1 | none | none | none | docs/04-answerable-id-schema.md |
| bootstrap.applied | src/bootstrap.ts | 2 | none | none | none | docs/04-answerable-id-schema.md, apps/id/README.md |
| capability.created | src/services/capabilities.ts | 1 | none | none | none | docs/04-answerable-id-schema.md |
| capability.removed | src/services/capabilities.ts | 1 | none | none | none | docs/04-answerable-id-schema.md |
| capability.updated | src/services/capabilities.ts | 1 | none | mcps/toolbox/src/poller.test.ts | none | docs/04-answerable-id-schema.md |
| client.created | src/services/clients.ts | 3 | none | mcps/toolbox/src/poller.test.ts | none | docs/04-answerable-id-schema.md |
| client.disabled | src/services/clients.ts | 2 | none | none | none | docs/04-answerable-id-schema.md |
| client.enabled | src/services/clients.ts | 2 | none | none | none | docs/04-answerable-id-schema.md |
| client.erased | src/services/clients.ts | 4 | none | none | id/manage.mdx | docs/04-answerable-id-schema.md |
| client.grants_erased | src/services/clients.ts, drizzle/0001_invariants.sql | 3 | none | none | id/manage.mdx | docs/04-answerable-id-schema.md |
| client.grants_revoked | src/services/clients.ts, drizzle/0001_invariants.sql | 6 | none | none | id/manage.mdx | docs/04-answerable-id-schema.md |
| client.resource_linked | src/services/clients.ts | 2 | none | none | id/manage.mdx | docs/04-answerable-id-schema.md |
| client.resource_unlinked | src/services/clients.ts | 2 | none | none | id/manage.mdx | docs/04-answerable-id-schema.md |
| client.secret_rotated | src/services/clients.ts | 5 | none | none | none | docs/04-answerable-id-schema.md |
| client.updated | src/services/clients.ts | 2 | none | none | none | docs/04-answerable-id-schema.md |
| domain.created | src/services/domains.ts | 1 | none | none | none | docs/04-answerable-id-schema.md |
| domain.deleted | src/services/domains.ts | 2 | none | none | id/onboard.mdx | docs/04-answerable-id-schema.md |
| domain.disabled | (not literal) | 1 | none | none | none | docs/04-answerable-id-schema.md |
| domain.enabled | (not literal) | 1 | none | none | none | docs/04-answerable-id-schema.md |
| entitlement.created | src/services/entitlements.ts, drizzle/0001_invariants.sql | 4 | none | mcps/toolbox/src/poller.test.ts | none | docs/04-answerable-id-schema.md |
| entitlement.disabled | drizzle/0001_invariants.sql | 1 | none | none | none | docs/04-answerable-id-schema.md |
| entitlement.enabled | drizzle/0001_invariants.sql | 1 | none | none | none | docs/04-answerable-id-schema.md |
| entitlement.removed | src/services/entitlements.ts, drizzle/0001_invariants.sql | 2 | none | mcps/toolbox/src/poller.test.ts | none | docs/04-answerable-id-schema.md |
| entitlement.updated | src/services/entitlements.ts, drizzle/0001_invariants.sql | 2 | none | mcps/toolbox/src/poller.test.ts | none | docs/04-answerable-id-schema.md |
| group.created | src/services/groups.ts | 2 | none | none | none | docs/04-answerable-id-schema.md |
| group.disabled | drizzle/0001_invariants.sql | 3 | none | mcps/toolbox/src/poller.test.ts | none | docs/04-answerable-id-schema.md |
| group.enabled | drizzle/0001_invariants.sql | 3 | none | none | none | docs/04-answerable-id-schema.md |
| group.erased | src/services/groups.ts, drizzle/0001_invariants.sql | 3 | none | none | none | docs/04-answerable-id-schema.md |
| group.updated | src/services/groups.ts | 2 | none | none | none | docs/04-answerable-id-schema.md |
| group_member.added | src/services/groups.ts | 2 | none | mcps/toolbox/src/poller.test.ts | none | docs/04-answerable-id-schema.md |
| group_member.removed | src/services/groups.ts | 2 | none | none | none | docs/04-answerable-id-schema.md |
| group_member.updated | src/services/groups.ts | 2 | none | none | none | docs/04-answerable-id-schema.md |
| identity.linked | src/auth/verified-sso.ts | 1 | none | none | id/sign-in.mdx | docs/04-answerable-id-schema.md |
| member.reinstated | src/services/members.ts | 2 | none | none | id/manage.mdx | docs/04-answerable-id-schema.md |
| member.removed | src/services/members.ts | 5 | none | mcps/toolbox/src/poller.test.ts | id/manage.mdx | docs/04-answerable-id-schema.md |
| member.updated | src/services/members.ts | 5 | none | none | id/manage.mdx | docs/04-answerable-id-schema.md |
| oauth.token.issued | src/auth/machine-audit.ts | 4 | none | none | id/sign-in.mdx, id/manage.mdx | docs/04-answerable-id-schema.md |
| oauth.token.rejected | src/auth/machine-audit.ts | 3 | none | none | id/sign-in.mdx, id/manage.mdx | docs/04-answerable-id-schema.md |
| oauth.user.authorized | src/auth/user-oauth-audit.ts, src/auth/user-oauth-flow.ts, drizzle/0001_invariants.sql | 1 | none | none | none | docs/04-answerable-id-schema.md |
| oauth.user.denied | src/auth/user-oauth-audit.ts, src/auth/user-oauth-flow.ts, drizzle/0001_invariants.sql | 1 | none | none | none | docs/04-answerable-id-schema.md |
| oauth.user.issued | src/auth/user-oauth-audit.ts, src/auth/user-token-boundary.ts, drizzle/0001_invariants.sql | 1 | none | none | none | docs/04-answerable-id-schema.md |
| oauth.user.revoked | src/auth/user-oauth-audit.ts, src/auth/user-token-boundary.ts, src/auth/user-token-revocation.ts, drizzle/0001_invariants.sql | 1 | none | none | none | docs/04-answerable-id-schema.md |
| organization.created | src/services/organizations.ts | 5 | mcps/admin/src/provider.ts | mcps/admin/src/provider.test.ts, packages/id-admin/src/testing.test.ts, packages/acceptance/src/journeys/admin.journeys.test.ts | mcp/local-testing.mdx | docs/04-answerable-id-schema.md |
| organization.disabled | src/services/organizations.ts, drizzle/0001_invariants.sql | 2 | none | mcps/toolbox/src/poller.test.ts | none | docs/04-answerable-id-schema.md |
| organization.enabled | src/services/organizations.ts | 0 | none | none | none | docs/04-answerable-id-schema.md |
| organization.erased | src/services/organizations.ts, drizzle/0001_invariants.sql | 4 | none | none | none | docs/04-answerable-id-schema.md |
| organization.updated | src/services/organizations.ts | 6 | none | none | none | docs/04-answerable-id-schema.md |
| resource.created | src/services/resources.ts | 2 | none | none | none | docs/04-answerable-id-schema.md |
| resource.disabled | src/services/resources.ts, drizzle/0001_invariants.sql | 4 | none | none | none | docs/04-answerable-id-schema.md |
| resource.enabled | src/services/resources.ts | 2 | none | none | none | docs/04-answerable-id-schema.md |
| resource.erased | src/services/resources.ts, drizzle/0001_invariants.sql | 4 | none | none | none | docs/04-answerable-id-schema.md |
| resource.updated | src/services/resources.ts | 2 | none | none | none | docs/04-answerable-id-schema.md |
| session.revoked | src/services/sessions.ts | 2 | none | none | id/manage.mdx | docs/04-answerable-id-schema.md |
| session.revoked_all | src/services/sessions.ts | 2 | none | mcps/toolbox/src/poller.test.ts | id/manage.mdx | docs/04-answerable-id-schema.md |
| sso_provider.created | src/services/sso-providers.ts, drizzle/0001_invariants.sql | 1 | none | none | none | docs/04-answerable-id-schema.md |
| sso_provider.deleted | src/services/sso-providers.ts, drizzle/0001_invariants.sql | 1 | none | none | none | docs/04-answerable-id-schema.md |
| sso_provider.updated | src/services/sso-providers.ts, drizzle/0001_invariants.sql | 1 | none | none | none | docs/04-answerable-id-schema.md |
| user.disabled | src/services/users.ts | 3 | mcps/toolbox/src/poller.ts | mcps/toolbox/src/poller.test.ts | toolbox/index.mdx, id/manage.mdx | docs/04-answerable-id-schema.md |
| user.email_retired | src/services/users.ts | 1 | none | none | none | docs/04-answerable-id-schema.md |
| user.enabled | src/services/users.ts | 3 | none | none | none | docs/04-answerable-id-schema.md |
| user.erased | src/services/users.ts, drizzle/0001_invariants.sql | 6 | mcps/toolbox/src/poller.ts | mcps/toolbox/src/poller.test.ts | toolbox/index.mdx | docs/04-answerable-id-schema.md |

Readers by prefix, which the string search above cannot see: `mcps/toolbox/src/poller.ts:9-12` reads `/audit-events` and selects events with `organisationActions = ["capability.", "entitlement.", "group_member.", "group.", "member.", "organization."]` (it adds the event's organisation to the set to refresh) and `userActions = ["user."]` (adds the target user). `mcps/admin/src/provider.ts:172-187` (`audit.list`) lists every action and filters by an exact `action` string the caller supplies. So:

- **Read by the Toolbox poller (28):** `capability.*` 3, `entitlement.*` 5, `group_member.*` 3, `group.*` 5, `member.*` 3, `organization.*` 5, `user.*` 4.
- **Written, read by no code (38):** `admin.auth_failed`, `admin.denied`, `admin.root_request`, `auth.signin.rejected`, `auth.signin.succeeded`, `auth.signout`, `bootstrap.applied`, `identity.linked` (8); `client.*` 10 (`created`, `disabled`, `enabled`, `erased`, `grants_erased`, `grants_revoked`, `resource_linked`, `resource_unlinked`, `secret_rotated`, `updated`); `domain.*` 4 (`created`, `deleted`, `disabled`, `enabled`); `oauth.*` 6 (`token.issued`, `token.rejected`, `user.authorized`, `user.denied`, `user.issued`, `user.revoked`); `resource.*` 5; `session.*` 2; `sso_provider.*` 3. All are reachable by the generic `audit.list` tool and by `GET /audit-events`, are documented in the design table, and are the compliance record; none drives an automatic action.
- **Readers with no writer:** none. Every action the poller's prefixes or the docs name is in the list, and every listed action has a writer (one in a trigger or a check only, see the table: `entitlement.disabled` and `entitlement.enabled`, `group.enabled`, and `group.disabled` appear as literals only in the SQL, and are written in code through `statusAction`).
- **Observation for the Toolbox's reader, not a finding:** the poller's prefixes do not include `client.`, `resource.`, `domain.`, `sso_provider.` or `session.`; `client.grants_revoked`, `client.disabled` and `resource.disabled` are changes that can alter what a member's token may do. Whether those events matter to the Toolbox's cache is a question for the Toolbox's auditor; I did not test it. `organization.enabled` has no ID test naming it (0 in the table); `capability.*` has a poller test naming one action, `capability.updated`.
- Docs name 19 actions in 5 pages (`id/manage.mdx`, `id/onboard.mdx`, `id/sign-in.mdx`, `toolbox/index.mdx`, `mcp/local-testing.mdx`).

## 11. Test support (item 11)

Command 11 (`11-support.ts`). `apps/id/src/__tests__` holds 29 files and 1,975 lines. 77 named exports (functions, constants, types; `export type * from` re-exports of query modules are not counted). Importers are counted over `src/**` and `scripts/**` from static `import` statements; the table gives test files importing the name, then other support files importing it, then internal references within the file. `preload.ts` is the bun preload (`bunfig.toml:3`) and `operation-worker.ts` is spawned by path from `http/admin/operation-crash.integration.test.ts:46`; both export nothing.

Files by number of distinct importing files: `support.ts` 62, `admin.ts` 54, `platform-context.ts` 43, `admin-routes.ts` 16, `organization-queries.ts` 14, `operation-receipt.ts` 14, `runtime-role.ts` 14, `federation.ts` 13, `capabilities.ts` 13, `test-database.ts` 12, `tenant-command.ts` 12, `group-queries.ts` 12, `resource-queries.ts` 11, `client-queries.ts` 11, `grants.ts` 10, `bind-query.ts` 9, `sso-queries.ts` 9, `domain-queries.ts` 7, `oidc-issuer.ts` 7, `openapi-response.ts` 7, `after-broker-read.ts` 6, `entitlement-queries.ts` 5, `soft-deletion.ts` 4, `audit-queries.ts` 4, `migration-catalogue.ts` 2, `database-clock.ts` 2, `user-queries.ts` 2.

**Exports imported by exactly one file (10):**

| Export | The one importer |
|---|---|
| `platform-context.ts: rootAuthority` | `__tests__/tenant-command.ts` (another support file) |
| `domain-queries.ts: setOrganizationDomainStatus` | `http/pages/pages.integration.test.ts` |
| `domain-queries.ts: organizationAcceptsDomain` | `db/schema.integration.test.ts` |
| `migration-catalogue.ts: committedStatements` | `db/migrations.integration.test.ts` |
| `migration-catalogue.ts: readCatalogue` | `scripts/test-migrations.ts` |
| `sso-queries.ts: updateSsoProvider` | `db/queries/sso-providers.integration.test.ts` |
| `sso-queries.ts: deleteSsoProvider` | `db/queries/sso-providers.integration.test.ts` |
| `oidc-issuer.ts: OidcTokenFault` | `services/federation.integration.test.ts` |
| `audit-queries.ts: listUserAuditEvents` | `db/queries/audit.integration.test.ts` |
| `entitlement-queries.ts: deleteEntitlement` | `services/clients.integration.test.ts:373` (a dynamic `await import`, which the static parse missed; the script showed it as zero importers) |

No export has zero importers. The full 77-row table (name, test importers, support importers, internal references) is in `11-support-table.md`; it was generated without the dynamic-import case, so `deleteEntitlement` reads 0 there.

## 12. Measured numbers: where each came from

| Number | Source |
|---|---|
| 0 knip findings, 42 hints | command 1, `01-knip.txt` |
| 37 clones, 445 duplicated lines, 1.90%, 23,467 TS lines, 165 files | command 2 summary table, `02-jscpd.txt` |
| 0 unused locals/parameters | command 3, three empty outputs, exit 0 |
| 259 non-null, 85 `req.param` non-null, 6 console, 187 sql, 29 catch, 0 for the rest | `04-smells-summary.txt`, `04-smells-matches.tsv` (85 = lines matching `req.param` in the non-null set) |
| 162 files, 22,998 lines, ten largest, per directory | `05-sizes.txt` |
| 80 routes (32/43/5 by kind, 22/58 by tier), 43 without a runtime caller, 31 without any non-ID-test caller, 9 not in docs | `06-routes.json`, `06-table.md`, `06-no-runtime-caller.txt`; the runtime-caller map in `06-final.ts` was resolved by reading the call sites cited in section 6 |
| 16 allowed Better Auth routes | `07-auth-table.md` |
| 30 variables, 13 never set by the chart, the stack or the deploy (plus 2 Google variables set only on request) | `08-env-table.md`, plus `charts/answerable/templates/id.yaml:2-34` and `infra/pipeline/src/deploy.ts:94-120` |
| 36 declared dependencies, 9 rows a major behind (3 dev tools in 3 packages) | `09-deps-table.md`, `npm view` |
| 66 actions, 28 read by prefix, 38 not read by code | `10-actions-table.md`, `mcps/toolbox/src/poller.ts:9-12` |
| 77 exports, 10 imported by one file | `11-support-table.md`, `11-support-once.txt` |

## 13. What I could not verify

- The method of a support-caller hit in section 6 (path-level only); the runtime-caller column is method-confirmed.
- Callers outside the listed consumer set: the web app's `/oauth-test` page, Claude Code or other MCP hosts, and humans with curl are not greppable. The route and auth tables therefore show repository callers only.
- Whether the Toolbox's prefix list (section 10) is complete for its cache; untested.
- Section 8 counts a name match anywhere in a file set; a variable named only in a comment would read `yes`. The 14 "never set" rows are exact for absences.
