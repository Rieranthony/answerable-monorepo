# Staging evidence

What the first staging deploy on Civo established, run by run, with the numbers the runbook asks for. Started on 2026-10-23; completed when the smoke test passes. Environment `staging`, zone `answerable-staging.uk`, Civo LON1.

## Runs

| Tag | Run | Outcome |
| --- | --- | --- |
| `staging/first` (75f74819) | 39758319327 | Terraform init refused: the state credential and bucket were in NYC1 (the Civo CLI reads no region variable). Rerun after the fix: the lock write refused with `XAmzContentSHA256Mismatch` (the AWS SDK's default trailing checksum). |
| `staging/second` (5de5bcf1) | 39918756680 | Lock acquired; network, three firewalls, reserved address and database created; the cluster refused `-Traefik-v2-nodeport` (the marketplace name is `traefik2-nodeport`). |
| `staging/third` (e349de58) | 39922177773 | Apply complete, 33 resources; images pulled; ops `bootstrap` created the three databases and six logins; ID's migration Job refused `revoke execute on all functions in schema public` (`pgsm_create_view`, Civo's pg_stat_monitor); release rolled back. |

## The environment after `staging/third`

| Fact | Value |
| --- | --- |
| Cluster | `answerable-staging-cluster`, API `https://74.220.17.101:6443` |
| Load balancer | `74.220.16.255` |
| Database | `answerable-staging-database`, `10.10.0.6:5432` on the private network |
| Origin certificate expires | 2041-10-19 (Cloudflare Origin CA; calendar it, nothing renews it) |
| GitHub environment | 12 names: the five pasted, the two state keys, ID's two secrets, `KUBE_SERVER`, `KUBE_CA`, `KUBE_TOKEN` |

## The database's TLS (ops `bootstrap`, 2026-10-23)

- It serves TLS. Chain: leaf `CN=pg-db-answer-25dc-08bd5a-primary` issued by `CN=dbaas-ca`; root `CN=dbaas-ca`, self-signed.
- Root validity: 2026-07-28 to **2027-07-28**. One year. The ConfigMap `postgres-ca` pins it (trust on first use); before it expires, delete the ConfigMap and run `bootstrap` again, or every login fails to verify. Calendar: June 2027.
- Root SHA-256 fingerprint: `81:6B:F3:2A:5A:C5:82:4F:3F:E5:98:85:36:B5:3A:2E:87:73:7E:D7:DC:E5:43:7F:91:27:EF:35:B7:E5:D9:41`. Civo shows no fingerprint to compare against.
- Leaf names: `DNS:pg-db-answer-25dc-08bd5a-primary`, `DNS:pg-db-answer-25dc-08bd5a-ha-headless`. They do not cover `10.10.0.6`, the host every URL names. The migration Job connected with `sslmode=verify-full` regardless, on Bun. **Open question:** what identity check Bun's TLS performs for an IP host; until proven, treat the connection as chain-verified against the pinned root (verify-ca semantics), not name-verified.

## Image pulls

The cluster pulled `ghcr.io/rieranthony/answerable/ops` by digest without a change to the packages' visibility, so the tutorial's step 7.2 was not needed.

## Still to record

The ops `register` Job's two `claude mcp add` lines, the smoke test's checks, Traefik's seen address.
