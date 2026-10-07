# Findings

Every entry carries its evidence: a grep with zero callers, a tool report, a measured number or a quoted line. Verdicts are set in phase 3.

## Mechanical baseline (phase 1, 2026-10-07, tree 436909e)

Tool output: scratchpad `baseline/knip.txt`, `baseline/jscpd.txt` (session scratchpad `/private/tmp/claude-501/-Users-anthonyriera-code-answerable/a13330aa-9209-40b3-a526-4810e5ef753d/scratchpad/baseline`).

**Size.** Non-test source lines: apps/id 27,423 · apps/web 4,372 · packages/mcp 1,860 · mcps/admin 1,445 · mcps/toolbox 1,041 · packages/ui 971 · packages/acceptance 799 · packages/id-admin 741 · packages/mcp-postgres 322 · mcps/e2e 321 · packages/auth 242 · mcps/example 155 · scripts 122 · packages/countries 74. ID test lines: ~45,000 (reviewed by the test audit; not in scope).

**Suppressions and casts (non-test source).** `TODO|FIXME|HACK`: 0. `eslint-disable`: 0. `@ts-ignore|@ts-expect-error`: 0. `as any`: 0. `as unknown as`: 4 (web openapi JSON import, two in ID test support, one in the conformance kit). Non-null assertions (`x!`): 320, of which `context.req.param("…")!` 86 and `context.get("principal")!` 13 in ID. `console.*`: 63, all in scripts, servers' entry points and operational logging (none in request handlers except error logging). Empty catch blocks: 0. `sql.raw`/`.unsafe(`: only in migrators, fixtures and `columns.ts`'s literal list (quoted). `Math.random`: 0.

**tsc with `noUnusedLocals`/`noUnusedParameters` on apps/id:** one hit, `src/auth/machine-provider.ts:25` (`options` never read).

**knip 6.40 (config `knip.json` at the root, kept for re-runs).**
- Unused files: `mcps/example/src/docs/{composition,custom-error,dependencies,deprecation,tool-errors}.ts`: false positives, each is included by one docs page (verified by grep of `<include`). Keep.
- Unused dependencies: `motion` (apps/web; nothing imports it), `shiki` (apps/web; nothing imports it, Fumadocs brings its own), `cn` (packages/ui; a bogus package the shadcn CLI once wrote). Unused devDependency: `shadcn` (apps/web; a CLI run by hand, keep or move). Unlisted: `server-only` imported by `apps/web/components/docs/og-image.tsx` but not declared (isolated linker; works only because Next resolves it).
- `packages/ui/package.json` exports `./hooks/*` → `src/hooks/*.ts`, but `src/hooks` holds no `.ts` file.
- Unused exports in production code: `freshAuthenticationSeconds` (auth/fresh-authentication.ts), `databaseBusy` (http/problem.ts), `requestBodyTimeoutMs` (http/request-limits.ts), `deprecationSentence` (packages/mcp/src/tool.ts), `LOGO_PATHS`, `SquareMark`, `CommaMark` (web logo.tsx), `useMDXComponents` (duplicate of `getMDXComponents`), `errorMeanings` (web lib/docs/error-codes.ts), `displayType` (web lib/docs/markdown.ts), dither-kit helpers `seedOfColor`, `isDitherColor`, `clamp01`, `fnv1a`, `xorshift32`, `hueFill`, `pixelPrefersReducedMotion`. Unused exported types: `PlatformApplication`, `OwnOidc`, `PlatformOidc`, `UserStatus`, `Problem`, `GradientDirection`, `LogoGroup`, `LogoPath`, `DitherType`, `Rot`, `OpenedSheet`, `WaitlistErrors`, `Caller` (toolbox meta.ts). Each needs a check: used only inside its file (drop `export`) or not at all (delete).
- Unused exports in ID test support (`src/__tests__/*-queries.ts`, `support.ts`, `test-database.ts`): 37 bound query wrappers nothing imports.

**jscpd 5.4 (non-test source, ≥60 tokens and ≥6 lines):** 35 exact clones, 520 lines (1.42%). Largest pairs: `db/queries/organizations.ts`↔`users.ts` 60 lines; `http/admin/entitlements.ts`↔`groups.ts` 50; `groups.ts` with itself 37; `users.ts` with itself 36; `oauth-clients.ts`↔`users.ts` 35; `capabilities.ts`↔`entitlements.ts` 30. Exact duplication is low; the structural repetition below is the real cost.

**Structural repetition in apps/id (grep).**
- `function requireRow<T>` defined in 8 service files (`sso-providers`, `entitlements`, `domains`, `clients`, `groups`, `access`, `members`, `sessions`), each a `ProblemError(404, "not_found", …)` with its own message; 16 `ProblemError(404` sites, 85 `new ProblemError(` in all.
- A local `audit(…)` wrapper around `recordAuditEvent` in 11 service files, plus `auditDomain`/`auditClient`/`auditResource`/`auditResourceLink` shapers.
- `sql\`${table.deletedAt} is null\``: 170 occurrences in 25 files, where drizzle's `isNull()` or one `live(table)` helper would do.
- `require(Platform|Tenant)*Context(` capability checks: 172 call sites in 28 files; 23 test assertions on "Invalid or expired" errors. Branded, frozen context objects created by `platform-context.ts` and `tenant-context.ts`; the WeakSet membership check re-verifies at every query what the private-symbol type already guarantees at compile time, except use after the `run` callback ended.
- `context.req.param("x")!` 86 times after a `validate("param", schema)` middleware that already parsed it.
- `platformCommand` / `platformUsersCommand` / `tenantMemberCommand` in `http/admin/command.ts` differ only in the authoriser; every write route repeats the sentence "Requires Idempotency-Key. Identical authorised retries return the receipt without repeating its audit or mutation. Changed input returns idempotency_key_reused." in its description.

**Repository inventory.**
- `default.env`: every variable is read somewhere except `REDIS_URL`; `docker-compose.yml` starts a Redis nothing connects to ("Redis read cache later" is a standing decision; the container and the variable are not needed to keep it).
- `package.json` scripts: every non-standard script is referenced from docs, CI or turbo.
- `turbo.json` names only existing workspaces.
- Dependencies vs imports: apps/web `motion`, `shiki` (above); `@mdx-js/mdx` is the deliberate Fumadocs peer pin (AGENTS.md); `tailwindcss` is used from CSS; apps/id `@hono/standard-validator` has no direct import but is the optional peer `hono-openapi`'s validator loads at runtime: keep.
- Local only, not tracked: `packages/mcp-base/` (an empty leftover with `.turbo` and `node_modules`), `.claude/worktrees` is clean.


## Area G: repository configuration, env, docs (coordinator)

| ID | Where | Category | Finding | Evidence | Proposal |
|----|-------|----------|---------|----------|----------|
| G1 | `docker-compose.yml:22-30`, `default.env:58-59`, `.env.example:18`, README ports table, `AGENTS.md:56`, `docs/02-plan.md:20`, `apps/web/README.md:14` | dead | A Redis container and `REDIS_URL` that no code reads | `grep -rn REDIS_URL apps packages mcps scripts` → 0; docs/06 says "do not provision it for ID" | Remove the compose service, the variable and the port rows; keep the "Redis read cache later" sentence in docs/01 and docs/02 as the standing decision |
| G2 | `apps/id/package.json:28` | keep | `@hono/standard-validator` has no import in ID's source, but `hono-openapi`'s `validator` imports `sValidator` from it at runtime and lists it as an optional peer; under Bun's isolated linker ID must declare it | `node_modules/hono-openapi/dist/index.js:2`; `peerDependenciesMeta` optional | Keep (withdrawn: audit C confirmed the peer) |
| G3 | `turbo.json` `@answerable/id#dev` and `#test` `passThroughEnv` | ugly | The two lists repeat 15 entries and both miss `PROTOCOL_SWEEP_INTERVAL_MS` and `PROTOCOL_SWEEP_BATCH` (added last week), so a turbo-run ID ignores them | `grep -c PROTOCOL_SWEEP turbo.json` → 0; `env.ts` reads both | Add `PROTOCOL_SWEEP_*` to both lists (turbo has no anchors; the duplication stays) |
| G4 | `reports/answerable-id-request-reuse.md` | dead | A 41-line investigation note nothing links, about a test client bug from 10 September, pointing at `reports/id-request-reuse-probe.mjs`, which no longer exists | link grep → 0 inbound; `ls reports/*.mjs` → none | Delete |
| G5 | `knip.json` (new) | keep | The knip configuration used for the baseline | re-runnable with `bunx knip` | Keep the file; mention the command in AGENTS.md's repo card; no new dependency and no CI step (automation is the last preference) |
| G6 | `.env.example` vs `default.env` | keep | `.env.example` carries only ID's local values; the Toolbox and admin MCP variables are documented on their docs pages and in `default.env` | `diff` of the variable names; `apps/web/content/docs/toolbox/index.mdx`, `admin/setup.mdx` | Keep as is: the template is for `bun dev`; the inventory is `default.env` |
| G7 | `reports/`, `docs/drafts/`, `apps/community-mcp/` | keep | Historical reports, two design drafts and the parked tutor MCP's docs: not code; every report but G4 is linked from a doc | link counts in the baseline run | Keep |

## Audit findings by area (phase 2)

The seven audits are in `audits/`: `a-id-auth.md` (26 findings), `b1-admin-http-services.md` (38), `B2.md` (32), `c-id-shell.md` (35), `d-mcp-kit.md` (14), `e-mcp-servers-acceptance.md` (16), `f-web-ui.md` (26). The verdicts are in `task_plan.md` "Decisions"; the outcome is in `conclusions.md`.
