# Module `cluster`

The Civo Kubernetes cluster (k3s, Cilium, Traefik removed) and the firewall in front of its nodes and API. The runbook is in [`infra/civo/README.md`](../../README.md).

## The firewall

Civo clusters always have a public address. The firewall carries only the rules below (`create_default_rules = false`). Each rule from the private network is a port a named component needs:

| Rule | Protocol and port | From | Why | Source |
| --- | --- | --- | --- | --- |
| `kubernetes-api` | TCP 6443 | `0.0.0.0/0` | The Kubernetes API, authenticated by the cluster | [k3s requirements](https://docs.k3s.io/installation/requirements#inbound-rules-for-k3s-nodes) |
| `node-ports` | TCP 30000-32767 | The private network | The Civo load balancer forwards 443 to Traefik's node port | [Kubernetes NodePort range](https://kubernetes.io/docs/concepts/services-networking/service/#type-nodeport); [Civo load balancers](https://www.civo.com/docs/networking/load-balancers/creating-load-balancers) |
| `kubelet` | TCP 10250 | The private network | The kubelet: metrics-server's scrapes, the API server's logs and exec | [k3s requirements](https://docs.k3s.io/installation/requirements#inbound-rules-for-k3s-nodes) |
| `cilium-vxlan` | UDP 8472 | The private network | Cilium's VXLAN overlay, which carries pod-to-pod traffic between nodes | [Cilium firewall rules](https://docs.cilium.io/en/stable/operations/system_requirements/#firewall-rules) |
| `cilium-health` | TCP 4240 | The private network | cilium-health's probes between nodes | [Cilium firewall rules](https://docs.cilium.io/en/stable/operations/system_requirements/#firewall-rules) |
| `cilium-health-ping` | ICMP | The private network | cilium-health's ping (echo request) | [Cilium firewall rules](https://docs.cilium.io/en/stable/operations/system_requirements/#firewall-rules) |

Outbound, the nodes may reach anything over TCP, UDP and ICMP: images from GHCR, DNS, the identity providers and Cloudflare.

**Why 6443 admits the internet.** GitHub-hosted runners, which run Terraform and the deploy, publish thousands of address ranges and cannot be listed in a firewall. The API therefore admits `0.0.0.0/0`, as every Civo cluster's does by default, and the cluster authenticates each request: TLS to the public endpoint, then a credential, either the namespace-scoped deployer token the workflows hold or the admin certificate kept in Terraform's state. This is how D30 (GitHub reaching the API) is resolved. The cost: a leaked deployer token works from anywhere until it is rotated, and a flaw in the API server is reachable from the internet.

**Not admitted on purpose.**

- Flannel's WireGuard ports (UDP 51820 and 51821), because k3s needs Flannel's ports only with Flannel. UDP 8472 is admitted, but for Cilium's own VXLAN.
- Embedded etcd (TCP 2379-2380) and Spegel (TCP 5001), because Civo runs the control plane and Spegel is not enabled.
- Cilium's Hubble (TCP 4244 and 4245), WireGuard (UDP 51871) and Geneve (UDP 6081), because none is configured.

The tests fail if a rule other than the API's admits the internet, if a rule from the private network spans every port or reaches 6443, or if a seventh rule appears.

**Open questions for the first apply** (also in the runbook's table):

- **Do `kubectl logs` and `exec` work?** They need the control plane to reach each kubelet on 10250.
- **Does Civo's Cilium tunnel over VXLAN on 8472?** The alternatives are Geneve on 6081 or native routing.
