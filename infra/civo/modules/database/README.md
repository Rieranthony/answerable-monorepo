# Module `database`

Civo's managed PostgreSQL 17 on the environment's private network, behind a firewall of its own. The runbook is in [`infra/civo/README.md`](../../README.md).

## Who can reach 5432: the private network, not the nodes alone

The ideal is 5432 from the cluster's nodes only. Civo cannot express that:

- **Firewall rules match addresses, not resources.** A rule's source is a set of CIDRs ([`civo_vpc_firewall`](https://registry.terraform.io/providers/civo/civo/1.3.3/docs/resources/vpc_firewall)).
- **Node addresses are unknown in advance and change.** Nodes take their addresses from the network as the pool scales or a node is replaced, and the provider exposes no node address, only `instance_names`.
- **A pool cannot get a range of its own.** No Civo resource places a cluster or a node pool in a subnet: `civo_kubernetes_cluster` and `civo_kubernetes_node_pool` take a `network_id` and nothing narrower, and `civo_vpc_subnet` takes no range. A pool in a network of its own could not reach the database privately, because a network isolates its members ([private networks](https://www.civo.com/docs/networking/private-networks)).

So the rule admits 5432 from the whole private network. By policy that network holds only this environment's:

- **Cluster nodes.** Pods reach the database from their node's address.
- **Load balancer.** Created by the cluster for Traefik's Service, it forwards only its configured port (443, to Traefik's node port). It cannot be made to open a connection to 5432.
- **The database itself**, and its standbys if the node count ever rises.

No instance and no other cluster may join it. Each environment is a separate Civo account, so staging's network and production's never meet.

**Known limit.** Anything that does join this network can reach PostgreSQL's port. It still needs a login: the runtime and owner logins are per database, and every connection is `verify-full` TLS. Revisit this when Civo offers per-pool subnets or firewall rules by resource.

Outbound, the database may reach the private network only (its standbys). Whether backups still work that way is checked by the restore drill.

## Nodes

One node in both environments. Civo's [getting-started page](https://www.civo.com/docs/database/getting-started) says only that with additional nodes "the database can continue to operate even if one or more nodes fail", with no mechanism and no price. Production's count rises to three only once brief B7c has measured that failover. The module accepts 1, 3 or 5.

## The administrator's URL

The sensitive output `admin_url` is the bootstrap Job's `OPS_DATABASE_ADMIN_URL`. The platform module writes it into the Secret `postgres-admin` in the `answerable` namespace, and the root outputs it as `database_admin_url` for break-glass only.

```
postgres://<username>:<password>@<private_ipv4>:<port>/postgres?sslmode=verify-full&sslrootcert=/etc/ssl/db/ca.pem
```

- **The login** is the `civo_database` resource's `username` and `password` attributes. Every character outside RFC 3986's unreserved set is percent-encoded, and a space becomes `%20`, never `+`.
- **The host** is the private address. If the first real bootstrap finds that the database certificate names `dns_endpoint` instead, the host switches.
- **The database** is `postgres`, Civo's default: "The default database name will be postgres" ([Connecting to your PostgreSQL database](https://www.civo.com/docs/database/postgresql/connect)).
- **The CA** at `/etc/ssl/db/ca.pem` is the ConfigMap `postgres-ca`, which the bootstrap Job writes on first use from the certificate chain the database presents, logging its SHA-256 fingerprint. Civo's pages never mention TLS, so the first apply must show that the database serves it at all.
