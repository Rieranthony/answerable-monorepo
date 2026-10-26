// The developer's local Answerable ID, as bun mcp setup and bun mcp dev use it: a token for a machine client, the admin API behind a bearer, and the
// registrations an MCP needs, made with the deploy's register Job's own registrar (infra/ops/src/registrar.ts) and safe to make again.
import { adminApi, failure, type Call } from "../../infra/ops/src/admin-api"
import { registerStandalone as registerAt, toolboxRows, type Registrar } from "../../infra/ops/src/registrar"
export { createRegistrar } from "../../infra/ops/src/registrar"
import type { Fetch } from "./io"
import { local, type Stack } from "./local"

/**
 * A `client_credentials` token of a machine client for `resource` with `scope`, or `undefined` when ID refuses the client or the audience. Throws when
 * ID does not answer at all.
 */
export async function machineToken(fetch: Fetch, { clientId, clientSecret }: { clientId: string; clientSecret: string }, resource: string, scope: string, stack: Stack = local) {
  const response = await fetch(`${stack.id}/auth/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", resource, scope }),
    signal: AbortSignal.timeout(10_000),
  })
  return response.ok ? ((await response.json()) as { access_token: string }).access_token : undefined
}

/** The local ID's admin API behind a bearer: ID's root secret, a staff token, or a machine client's token. Throws `RootLocked` when ID refuses the root secret. */
export const adminCall = (fetch: Fetch, token: string, stack: Stack = local): Call => adminApi({ id: stack.id, token, fetch: fetch as typeof globalThis.fetch, rootLocked: "ID's root secret is locked: a person is a platform administrator", timeoutMs: 15_000 })

/** The platform organisation's slug locally, which the local ID names at its first start. */
export const platformSlug = "answerable"

/** What a registrar made, changed and found as declared, in words. */
export const counts = ({ tally }: Registrar) => `${tally.made} made, ${tally.changed} changed, ${tally.found} found`

/** Every item of one of ID's lists, following its cursor. */
export async function all<Item>(call: Call, path: string) {
  const items: Item[] = []
  for (let cursor = ""; ;) {
    const answer = await call("GET", `${path}${path.includes("?") ? "&" : "?"}limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`)
    if (!answer.ok) throw failure("GET", path, answer)
    items.push(...(answer.body.items as Item[]))
    if (!answer.body.nextCursor) return items
    cursor = String(answer.body.nextCursor)
  }
}

/** The Toolbox in ID: its resource, its admin resource and Claude Code as its host client, as the register Job registers them. */
export async function registerToolbox(registrar: Registrar, stack: Stack = local) {
  const { resources, host } = toolboxRows(stack.toolbox, stack.callback)
  for (const [key, fields] of resources) await registrar.resource(key, fields)
  await registrar.client(...host)
}

/** A standalone MCP in ID at the stack's Toolbox, which serves it at its path, as the register Job registers it. Answers the resource's identifier. */
export const registerStandalone = (registrar: Registrar, mcp: { name: string; scopes: readonly string[] }, stack: Stack = local) =>
  registerAt(registrar, mcp, { mcpOrigin: stack.toolbox, callback: stack.callback })

/** bun mcp's machine client in ID. */
export const machine = "mcp-dev"

/**
 * mcp-dev, bun mcp's machine client, owned by the platform organisation `platform`: `platform:read platform:write` on ID's admin API and `toolbox:admin` on
 * the Toolbox's, each linked and approved. ID shows a client's secret once, when it makes the client, so one that exists is given a new secret. Safe to
 * repeat. Answers the secret, and whether the client was made now.
 */
export async function makeMcpDev(registrar: Registrar, platform: string, stack: Stack = local) {
  const held = await registrar.client(`${machine}-v1`, {
    clientId: machine, name: "bun mcp (local development)", organizationId: platform, tokenEndpointAuthMethod: "client_secret_basic",
    grantTypes: ["client_credentials"], clientCredentialsScopes: ["platform:read", "platform:write", "toolbox:admin"],
  })
  const made = typeof held.created?.clientSecret === "string"
  const clientSecret = made ? String(held.created!.clientSecret) : String((await registrar.write("POST", `/clients/${machine}/rotate-secret`, `${machine}-rotate-${crypto.randomUUID()}`)).clientSecret)
  for (const [name, resource, scopes] of [["id", stack.adminResource, ["platform:read", "platform:write"]], ["toolbox", stack.toolboxAdminResource, ["toolbox:admin"]]] as const) {
    await registrar.link(`${machine}-link-${name}-v1`, machine, resource, held)
    await registrar.write("POST", `/organizations/${platform}/capabilities`, `${machine}-capability-${name}-v1`, { clientId: machine, resource, grantKind: "client_credentials", scopes }, { create: true })
  }
  return { clientId: machine, clientSecret, made }
}
