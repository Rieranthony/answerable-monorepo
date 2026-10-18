# B7b — OpenBao, the secret store

**Executor:** Codex (GPT-6 Astra, medium) for the chart, the configuration, the ops code and the tests; the owner for the initialisation ceremony; Fable reviews and lands. **Depends on:** B7a (staging up on the interim scheme), B4a, B5. **Decisions:** [D23](../decisions.md), [D29](../decisions.md), [D21](../decisions.md), [D22](../decisions.md).

## Goal

OpenBao runs in the staging cluster and holds every secret the services, the ops Jobs and the platform need, except the one that unseals it. Each pod proves who it is with its Kubernetes identity and gets only its own secrets; every read is audited; a nightly snapshot lands in the object store and a restore has been rehearsed. The `sops` file shrinks to the seal key. Production gets the same in B7c.

## Facts to start from

From OpenBao's documentation, read on 12 October 2026 ([portability](../portability.md#the-tooling-the-core-relies-on)):

- A server starts sealed; the default Shamir seal needs a quorum of shares entered by hand after every restart. The **static key seal** is built in, takes a 32-byte key from a file or an environment variable, supports n-1 to n rotation, and is "only recommended when an existing source of trust … already exists": ours is the `sops` file.
- The official Helm chart defaults to "standalone mode" with file storage, "NOT appropriate for a production setup"; HA with integrated Raft storage is the production shape. The chart warns it is "under significant development": pin its version and app version and dry-run every upgrade.
- The Kubernetes auth method issues a scoped OpenBao token to a pod from its ServiceAccount token; External Secrets reaches OpenBao through its Vault provider; backups are `bao operator raft snapshot save` and `restore`.
- Initialising with an auto-seal yields recovery shares and a root token, not unseal shares; recovery shares authorise operations such as generating a new root token but cannot unseal if the seal mechanism is lost. Losing the static seal key therefore loses the data and every backup: the key's custody is the single most important step of this brief.

## Failing tests first

1. **The kind stack** (`infra/k8s/local`): the platform chart installs OpenBao (single replica, Raft, the static seal key from a Secret the test creates), Terraform's `vault` provider or a `bao` CLI Job configures it (KV v2 at `answerable/`, Kubernetes auth, one role and one policy per service and for External Secrets and the ops Jobs), the services' ExternalSecrets resolve from OpenBao, and every existing proof passes unchanged. New proofs: a pod with a ServiceAccount that has no role is refused; the Toolbox's policy cannot read ID's paths; sealing OpenBao by hand (`bao operator seal`) makes `/v1/sys/health` answer sealed and a restart unseals it with no one typing anything; a secret written through the ops store is readable only under its policy.
2. **`infra/ops`**: an `OpenBaoSecretStore` implementation of the `SecretStore` interface (KV v2 reads and writes with the Job's Kubernetes-auth token), `bootstrap` and `register` writing there; a `migrate-secrets` command that reads a decrypted `sops` document from standard input and writes each value to its OpenBao path, idempotent, never printing a value; 100% coverage with a fake OpenBao API.
3. **Chart tests** (`helm template` with `kubeconform` and assertions): three replicas, a PodDisruptionBudget of one, pod anti-affinity across nodes, TLS from cert-manager's internal issuer, the audit device enabled, resource requests set, the seal key mounted read-only from the `openbao-seal` Secret and nowhere else, no `latest` tag.
4. **Snapshot and restore**: a CronJob that runs `bao operator raft snapshot save` nightly and uploads to the environment's object store (S3-compatible) with 30-day retention; a test in the kind stack that takes a snapshot, destroys OpenBao's volume, restores the snapshot into a fresh OpenBao with the same seal key, and reads a secret back.
5. **Alerts** (Grafana): OpenBao sealed, snapshot CronJob failed, audit device write failure, `bao status` unhealthy; each fired once in staging by provoking it.

## What to build

- `charts/platform`: the `openbao` chart as a pinned dependency with values per environment (`server.ha.enabled`, `raft`, replicas, Civo volumes for Raft storage, `extraVolumes` for the seal key Secret, the `seal "static"` stanza in `server.ha.raft.config` with `current_key = "file:///openbao/seal/current"` and the key id derived from the key's hash, TLS from the internal `ClusterIssuer`, the audit device to stdout for the Grafana agent, `/v1/sys/health` probes); External Secrets Operator returns to the platform chart with a `ClusterSecretStore` of provider `vault` (server `https://openbao.openbao.svc:8200`, the internal CA, `auth.kubernetes` with the ESO role); the Grafana agent scrapes OpenBao's metrics endpoint.
- `charts/answerable`: the ExternalSecrets from B4a's original text come back, one per Secret the services and Jobs mount, with `refreshInterval` of a few minutes; each Deployment and Job gets its own ServiceAccount, which is the identity its OpenBao role binds to.
- OpenBao configuration as code, applied by the environment's Terraform root after initialisation with the `vault` provider against OpenBao's API (it is API-compatible): the `answerable/` KV v2 mount, the Kubernetes auth mount, policies (`id`, `toolbox`, `admin-mcp`, `ops-bootstrap`, `ops-register`, `external-secrets`, `cert-manager`), roles binding each policy to one ServiceAccount in the `answerable` namespace, the audit device. The root token is used for this one apply and then revoked; the Terraform provider authenticates afterwards with a short-lived token the owner generates from the recovery shares when configuration changes.
- `infra/ops`: the store implementation, `migrate-secrets`, and the `register` and `bootstrap` Jobs' values switched to OpenBao.
- The `sops` file after migration: the seal key, and nothing else. The deploy workflow's secrets step applies only `openbao-seal`.
- Runbook sections in `infra/README.md`: initialisation ceremony (generate the seal key with `openssl rand 32` into the `sops` file, apply, `bao operator init` from a port-forward on a trusted machine, store the recovery shares and the initial root token offline, apply the configuration, revoke the root token), seal key rotation (n-1 to n with `previous_key`), generating a root token from recovery shares, adding a secret, adding a service and its policy, snapshot restore, what to do when OpenBao is sealed or down, upgrading the chart (`--dry-run` first, one minor version at a time).
- Docs: `docs/12-deployment.md` § Secrets rewritten for OpenBao with the interim scheme as history; `docs/02-plan.md`: `Q-SECRET-STORE` resolved into D29; the tour page's section 9.

## Rollout on staging, in order

1. Apply the platform chart with OpenBao sealed; the seal key Secret comes from the `sops` file.
2. The owner initialises OpenBao from a trusted machine and stores the recovery shares and root token offline.
3. Terraform applies the OpenBao configuration; the root token is revoked.
4. `migrate-secrets` moves the values from the `sops` file into OpenBao; ExternalSecrets sync; the Deployments restart; the smoke passes.
5. The `sops` file is reduced to the seal key and committed; the deploy proves it still works end to end.
6. A snapshot is taken, restored into a scratch namespace and read back; the alerts are provoked once each; the numbers (restore time, OpenBao's memory and CPU on the nodes) go into the evidence report.

## Constraints

- No Shamir manual unseal anywhere; the static seal is the only seal.
- The seal key never enters Terraform, a log, a values file or an image.
- The root token exists only during the ceremony and the configuration apply.
- Official chart only, pinned; no fork, no custom image.
- Sizing: OpenBao's requests (start at 256 MiB and 250m per replica) are added to the node arithmetic; if staging's two Medium nodes cannot hold it with the rest, the values file grows the pool and the cost page records the delta.

## Acceptance

`bun run infra:test` green with OpenBao in the loop; `bun run infra:check` green; `bun run mcp:check @answerable/infra-ops` at 100%; staging running on OpenBao with the `sops` file holding only the seal key; a snapshot in the object store and a rehearsed restore; each alert seen once; the runbook sections written; `bun --filter web test` green.

## Notes from the build

(Filled by the executor.)
