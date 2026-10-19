# B7c — The production rehearsal

**Executor:** the owner, with an agent that has the Civo session and the browser. **Depends on:** B7a on `main` and proved on staging. **Decisions:** [D8](../decisions.md), [D28](../decisions.md), [D32](../decisions.md), [D37](../decisions.md).

## Goal

Production is proved one tag away: the `answerable-production` Civo account is stood up by the promote workflow, initialised, smoke-tested through `id.answerable.org`, `toolbox.answerable.org` and `admin-mcp.answerable.org`, and then destroyed again or kept, the owner's call.

## Steps, in order

1. **The environment for `answerable.org`**: B7a's inputs repeated for production: the Civo account and key, the zone's token, Bot Fight Mode off, the production Entra redirect URIs (`docs/06`), the GitHub environment `production` with its policy (`main` and the tags `production/*`), the owner as required reviewer and the five secrets, `id.staffDomain` and `id.entraTenant` in `values-civo-production.yaml`. Run the **Bootstrap** workflow for `production`. `curl https://www.answerable.org` must be unchanged afterwards. Nothing from staging is reused: keys, tokens, certificates, passwords.
2. **The tag**: `production/first` on a commit staging has shipped; approve the run; the `production` job applies `infra/civo` for production (network, firewalls, three-node cluster, the Medium database on one node, the records, the certificates) and deploys the verified digests. Record the time from tag to green smoke.
3. **Sign in and `make-admin`** on production: B7a's step 4; the forged-header address proof once more.
4. **Lockdown and address proofs** against the production load balancer, as in B7a's steps 2 and 3.
5. **Restore drill**: the Civo Database restore (B7a's step 7) on production, timed. If the owner wants the database's additional nodes (D37), add them now and measure a failover.
6. **Then**: unless the owner keeps production, destroy it: a reviewed change removes `prevent_destroy` from the database module, and a workflow dispatch with a `destroy` input behind the `production` environment runs `terraform.sh production destroy`; confirm the database's final backup exists and the DNS records are gone. If it stays, the owner's first sign-in is the one on record.
7. **Evidence**: `reports/staging-evidence.md` gains the production section with every number above.

## Constraints

- No secret value in any report, log excerpt or commit; redact before pasting.
- Production is never deployed from a laptop; only the workflow.

## Acceptance

The production tag worked once end to end with the smoke green; the restore drill is recorded; production is either destroyed with its backup confirmed or kept; the evidence report says which.

## Notes from the build

(Filled by the executor.)
