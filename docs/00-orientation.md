# Orientation

> **TL;DR**
> - **Decides:** what the words mean, who the actors are, and the problem Answerable ID solves.
> - **Rule:** one identity for every product and every client; `sub` is the only join key.
> - **Not here:** how it fits together (`01-architecture.md`), how we build it (`02-plan.md`), the design itself (`03-answerable-id.md`).

## Glossary — read this first

| Term | Meaning |
| --- | --- |
| **Answerable ID** | Our identity service (`id.answerable.org`): brokers every client org's corporate login, is the OIDC login provider for our apps, and the OAuth 2.1 authorization server for our MCP servers. Canonical design: [`03-answerable-id.md`](03-answerable-id.md) |
| **MCP** | Model Context Protocol — the standard by which an AI assistant calls external tool servers. Our hosted MCP servers will authenticate through Answerable ID |
| **OmniChat** | Our chat product, a fork of the open-source LibreChat ("the fork") |
| **Cell** | One client's independent OmniChat deployment (own VM, own MongoDB). 74 tenants today, 63 with corporate SSO |
| **Omni Accelerator** | Our client community, hosted on Circle.so. Points its community SSO at Answerable ID |
| **Upstream IdP** | A client org's corporate identity provider (Microsoft Entra, Google Workspace) that Answerable ID federates with — once per org |
| **Tenant-scoped issuer** | The per-org Entra issuer URL (`…/<directory-id>/v2.0`) an SSO config row is pinned to, so a login from the wrong directory is rejected by Microsoft itself |
| **Organization** | Answerable ID's unit of a client: slug, email domains, its SSO config, its entitlements |
| **`sub`** | Answerable ID's stable user ID, carried in every token. **The only join key between systems** — email is display data |
| **Entitlement** | A row deciding which org/user may use which app or MCP server; re-checked at **every** token grant |
| **Golden rule** | No token carrying a user's identity is ever issued without that user's own authentication as evidence |
| **DCR / CIMD** | The two ways an external AI tool registers with an OAuth server; CIMD preferred, DCR restricted by policy |
| **Omni-Weaver** | Our tenant-provisioning system (per-cell configuration) |
| **OmniAdmin / OmniTable / `ocadmin`** | Our admin surfaces and CLI for the fleet |
| **Tailnet** | Our headscale private mesh network; admin access lives only there |
| **Civo** | The UK cloud provider hosting our central infrastructure (London) |
| **Tutor MCP** | The first hosted MCP server (parked in `apps/community-mcp` until Answerable ID ships) |

## Cast of names

| Name | Role |
| --- | --- |
| Answerable ID | **Built first.** Identity + authorization for everything below |
| Client corporate IdPs | Federated into Answerable ID once per org (admin-consent) |
| OmniChat cells | OIDC clients of Answerable ID; migrate cell by cell |
| Omni Accelerator (Circle) | Points its community SSO at Answerable ID (a planned flag-day cutover) |
| External AI tools (Claude Code, …) | OAuth clients of Answerable ID under the registration policy |
| Hosted MCP servers | OAuth resource servers of Answerable ID — the tutor is the first, later |

## The problem

**Identity doesn't scale.** N apps × M clients = N×M app registrations in client directories, each with an expiring secret; every new product multiplies the burden — and MCP servers make it untenable (Entra can't be an MCP authorization server; it lacks dynamic client registration). There is no unified user directory, and identity must not live inside the fork's database. Full statement: [`03-answerable-id.md` §Problem](03-answerable-id.md#problem).

## The idea

Each client org connects to **Answerable ID once** (a 5-minute admin-consent); from then on every app and MCP server we ship works for their users with zero further IT involvement. Answerable ID owns identity and authority under the golden rule; its Postgres is the canonical user directory; entitlements decide who may use what, re-checked at every grant; every issuance is audited. Better Auth is the base — plugins, not forks.

## Success criteria

1. **One consent per client** — we do not go back to client IT except on documented permission changes.
2. The golden rule holds everywhere: no user-subject token without that user's own authentication.
3. Every token issuance, refresh, and connect is in the audit log; offboarding denies new tokens within 5 minutes and expires existing access within 15–30.
4. A new app or MCP server is a client registration plus entitlements rows — hours, not weeks.
5. A cell (or Circle) can roll back to its old issuer with a pure environment change.
