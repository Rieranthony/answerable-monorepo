# B7c — The production rehearsal

**Executor:** the owner, with an agent that has the Civo session and the browser. **Depends on:** B7a and B7b on `main` and proved on staging. **Decisions:** [D8](../decisions.md), [D28](../decisions.md), [D29](../decisions.md).

## Goal

Production is proved one click away, with OpenBao in place from its first minute: the `answerable-production` Civo account is stood up by the promote workflow, initialised, smoke-tested through `id.answerable.org`, `toolbox.answerable.org` and `admin-mcp.answerable.org`, and then destroyed again or kept, the owner's call.

## Steps, in order

1. **The edge for `answerable.org`**: B7a's step 0 repeated for the production zone (Bot Fight Mode off, the production origin-pull certificate generated, uploaded and its CA committed under `infra/civo/envs/production`), and `curl https://www.answerable.org` unchanged afterwards.
2. **Production's `sops` file**: a fresh age key pair for production (B0), a fresh OpenBao seal key, and the production values of the human secrets that OpenBao will receive at migration; never a staging value. The production Entra app's redirect URIs are `docs/06`'s.
3. **The click**: dispatch `promote-production` with the default tag; approve; the `infra` job applies `infra/civo/envs/production` (network, firewalls, three-node cluster, the Medium database with its additional nodes, the object store, the records) and installs the platform chart with OpenBao sealed; the `deploy` job runs `bootstrap`, the migrations and the services. Record the time from click to green smoke.
4. **OpenBao ceremony for production**: B7b's rollout steps 2 to 5 on the production cluster; recovery shares and the root token stored offline, separately from staging's.
5. **ID first run and registration** on production: B7a's steps 4 and 5 with production values; the forged-header address proof once more.
6. **Lockdown and address proofs** against the production load balancer, as in B7a's step 1.
7. **Restore drills**: the Civo Database restore (B7a's step 8) and the OpenBao snapshot restore (B7b's step 6) once each on production, timed.
8. **Then**: unless the owner keeps production, `terraform destroy` through a dispatch with a `destroy` input behind the `production` environment; confirm the database's final backup exists, the OpenBao snapshot is in the object store, and the DNS records are gone. If it stays, the budget and alerts are live and the owner's first sign-in is the one on record.
9. **Evidence**: `reports/staging-evidence.md` gains the production section with every number above.

## Constraints

- No secret value in any report, log excerpt or commit; redact before pasting.
- Production is never deployed from a laptop; only the workflow.
- Nothing from staging is reused in production: keys, seal, tokens, certificates, passwords.

## Acceptance

The production click worked once end to end with OpenBao initialised and the smoke green; the restore drills are recorded; production is either destroyed with its backups confirmed or kept with its alerts live; the evidence report says which.

## Notes from the build

(Filled by the executor.)
