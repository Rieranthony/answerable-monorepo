# Magic links: progress

## 2 November 2026

- Goal opened. `main` is at `cfc2b200`, four commits ahead of origin: Next 16.4.3, Better Auth 1.7.15, Turbo output fix, `client_secret_post`. The raw-exception fix is in.
- Read the plugin's source and docs. It can issue and consume tokens, but ID must own the boundary.
- Delegated to Sonnet 5.5: Postmark research, React Email probe, repo pattern map.
- Prototype built and measured on Better Auth 1.7.15, after correcting a wrong base. Rerun by the coordinator: 1,543 pass, 0 fail.
- Independent attack found two critical flaws and several high. Design rewritten.
- Report published privately. The owner decided D1 to D4.
- All throwaway worktrees and containers removed. No feature code exists. Waiting for the go-ahead.
- The owner corrected the design: Entra is added on top of magic links, never replacing them, and staff set each per firm. Ran a focused probe of one person with both methods, which found that directory commands revoke every grant in the firm and that a removed directory's people were refused a link. Design, decisions, work plan and report updated. Probe removed.
- The owner asked whether staff can stop anyone, and approved two additions: admin MCP tools to disable and remove people, and a disabled person's address staying blocked until staff retire it. Reading the code added a fifth tool, `users.retireemail`, and `platform:users` for the admin MCP's machine client. Both went into W0. Read in code, not run. Design, decisions, work plan and report updated.

## 3 November 2026

- The owner said to start W0. One worktree, `.claude/worktrees/magic-w0` on branch `claude/magic-w0`, from `b47f276a`. Two Sonnet 5.5 agents built ID's fixes and the admin MCP tools; the coordinator built the edge rule and the narrower proxy list, and reviewed both.
- Client address: `cf-connecting-ip` first, `x-forwarded-for` as the fallback for the local stack. Cloudflare's ranges left ID's proxy list, because an address inside that list falls through to `x-forwarded-for`. They stay in Traefik's.
- Tag back: an image behind the database applies nothing and also leaves the runtime role's grants alone, since its role job would treat a table it does not know as an ordinary one. The ID agent found that risk; the coordinator made the change.
- Gates, final code: ID 1,527 pass, 0 fail, 100%. Acceptance 72 pass, 0 fail. Kind stack 123 pass, 0 fail. MCP suites 13 of 13 on the last two runs; an earlier run had two 5-second timeouts at a load average of 17 or more, which did not return in five reruns. Web 135 pass. Typecheck and lint 20 of 20. Build, `infra:check` and `knip` clean.
- Not proven until the first staging tag: Cloudflare's rule and header, the real `register` Job widening a capability on a deployed environment. The last platform administrator's refusal is only tested with a mock.
- The owner said to land everything on `main` and not to release to staging yet. W1 is next.
