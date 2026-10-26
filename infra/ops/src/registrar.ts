// What the deployment registers in Answerable ID, and how: the register Job's (register.ts) and bun mcp's in the developer's local ID
// (scripts/mcp/local-id.ts), so the two never differ. It imports nothing from @answerable/mcp, which the ops image does not carry.
import { type Answer, type Call, failure } from "./admin-api"

/** The scopes every host client signs a person in with, and the grants it signs in and refreshes with. */
export const signIn = ["openid", "offline_access"]
export const hostGrants = ["authorization_code", "refresh_token"]
const sorted = (values: Iterable<string>) => [...new Set(values)].sort()

/** A client as the registrar declares it. */
type ClientFields = {
  clientId: string
  name: string
  organizationId?: string
  tokenEndpointAuthMethod: "none" | "client_secret_basic"
  grantTypes: string[]
  redirectUris?: string[]
  scopes?: string[]
  clientCredentialsScopes?: string[]
}
/** What the registrar knows of a client after making sure of it: the creation's answer when it made it, its revision and the resources it is linked to. */
type Held = { created?: Record<string, unknown>; revision: number; resources: string[] }
type ResourceFields = { identifier: string; name: string; allowedScopes: string[]; accessTokenTtl: number }

// The fields of `wanted` whose value differs from what ID holds; lists compare as sets, since ID keeps its own order.
function differences(held: Record<string, unknown>, wanted: Record<string, unknown>) {
  const same = (a: unknown, b: unknown) => (Array.isArray(a) && Array.isArray(b) ? JSON.stringify(sorted(a)) === JSON.stringify(sorted(b)) : JSON.stringify(a) === JSON.stringify(b))
  return Object.fromEntries(Object.entries(wanted).filter(([field, value]) => value !== undefined && !same(held[field], value)))
}

/**
 * Resources, clients and links in ID as declared: each is read first, created with its `Idempotency-Key` when ID lacks it, and changed with `If-Match`
 * under `<key>-r<revision>` in the fields that differ, scopes and redirect URIs only widening. `tally` counts what it made, changed and found as
 * declared; `log` hears each row made or changed, and each scope an MCP's own resource stops allowing.
 */
export function createRegistrar(call: Call, log: (line: string) => void = () => {}) {
  const tally = { made: 0, changed: 0, found: 0 }
  async function read(path: string) {
    const answer = await call("GET", path)
    if (answer.status === 404) return undefined
    if (!answer.ok) throw failure("GET", path, answer)
    return answer
  }
  /**
   * A write with its key: made; or, as declared already, replayed (this caller made it before) or, for a create, a conflict (someone made it).
   * Anything else throws.
   */
  async function write(method: string, path: string, key: string, body?: unknown, { create = false } = {}) {
    const answer = await call(method, path, { key, body })
    const existed = create && answer.status === 409 && answer.body.code === "conflict"
    if (!answer.ok && !existed) throw failure(method, path, answer, key)
    if (existed || answer.replayed) tally.found++
    else {
      tally.made++
      log(`${key}: done`)
    }
    return answer.body
  }
  /**
   * Change what differs of a row ID holds, with its ETag, under `<key>-r<revision>`: a retried change replays, a later one is new. Answers the row's
   * revision afterwards.
   */
  async function update(path: string, key: string, held: Answer, wanted: Record<string, unknown>) {
    const patch = differences(held.body, wanted)
    if (!Object.keys(patch).length) {
      tally.found++
      return held.body.revision as number
    }
    const revised = `${key}-r${held.body.revision}`
    const answer = await call("PATCH", path, { key: revised, ifMatch: held.etag!, body: patch })
    if (!answer.ok) throw failure("PATCH", path, answer, revised)
    tally.changed++
    log(`${key}: changed ${Object.keys(patch).sort().join(", ")}`)
    // A replay answers the receipt, whose change moved the revision on by one.
    return (answer.body.revision as number | undefined) ?? (held.body.revision as number) + 1
  }
  return {
    tally,
    read,
    write,
    update,
    /** A resource as declared: created when ID has none, else changed where it differs; its scopes keep what it holds unless `own`, an MCP's own resource, follows its manifest. */
    async resource(key: string, fields: ResourceFields, own = false) {
      const path = `/resources/${encodeURIComponent(fields.identifier)}`
      const held = await read(path)
      if (!held) return void (await write("POST", "/resources", key, { classification: "platform_shared", organizationId: null, ...fields }))
      const holds = held.body.allowedScopes as string[]
      const dropped = own ? holds.filter(scope => !fields.allowedScopes.includes(scope)) : []
      if (dropped.length) log(`${fields.identifier}: its manifest no longer declares ${dropped.join(" ")}, so its resource stops allowing ${dropped.length === 1 ? "it" : "them"}`)
      await update(path, key, held, { name: fields.name, accessTokenTtl: fields.accessTokenTtl, allowedScopes: sorted(own ? fields.allowedScopes : [...holds, ...fields.allowedScopes]) })
    },
    /** A client as declared: created when ID has none, else its name, redirect URIs and scopes changed where they differ, the lists keeping what it holds. */
    async client(key: string, fields: ClientFields): Promise<Held> {
      const path = `/clients/${fields.clientId}`
      const held = await read(path)
      if (!held) {
        const created = await write("POST", "/clients", key, fields)
        return { created, revision: typeof created.revision === "number" ? created.revision : 1, resources: [] }
      }
      const widened = (field: "redirectUris" | "scopes" | "clientCredentialsScopes") => fields[field] && sorted([...((held.body[field] as string[] | null) ?? []), ...fields[field]])
      const revision = await update(path, key, held, { name: fields.name, redirectUris: widened("redirectUris"), scopes: widened("scopes"), clientCredentialsScopes: widened("clientCredentialsScopes") })
      return { revision, resources: held.body.resources as string[] }
    },
    /** A client's link to a resource, when the client's read lacked it, under `<key>-r<revision>` of the client, which a link changes. */
    async link(key: string, clientId: string, target: string, held: Held) {
      if (held.resources.includes(target)) return void tally.found++
      await write("PUT", `/clients/${clientId}/resources/${encodeURIComponent(target)}`, `${key}-r${held.revision}`)
    },
  }
}
export type Registrar = ReturnType<typeof createRegistrar>

/** Claude Code as a host client: public, signing a person in with `scopes` besides `signIn`, and sent back to `callback`. */
export const hostClient = (clientId: string, name: string, scopes: readonly string[], callback: string): ClientFields => ({
  clientId, name, tokenEndpointAuthMethod: "none", grantTypes: hostGrants, redirectUris: [callback], scopes: [...signIn, ...scopes],
})

/**
 * The Toolbox at origin `toolbox` in ID, as apps/web/content/docs/toolbox/admin.mdx registers it: its resource and the resource of its admin API, each
 * with its key, and Claude Code as its host client. Its machine client is each caller's own.
 */
export const toolboxRows = (toolbox: string, callback: string) => ({
  resources: [
    ["toolbox-resource-v1", { identifier: `${toolbox}/mcp`, name: "Toolbox", allowedScopes: ["offline_access", "toolbox"], accessTokenTtl: 900 }],
    ["toolbox-admin-resource-v1", { identifier: `${toolbox}/admin`, name: "Toolbox admin", allowedScopes: ["toolbox:admin"], accessTokenTtl: 300 }],
  ] as [string, ResourceFields][],
  host: ["claude-code-toolbox-v1", hostClient("claude-code-toolbox", "Claude Code (Toolbox)", ["toolbox"], callback)] as const,
})

/**
 * A standalone MCP in ID: its resource, `<mcpOrigin>/<name>/mcp`, with its manifest's `scopes` and `offline_access`, which follows the manifest; its
 * Claude Code client, `claude-code-<name>`; and their link. Answers the resource's identifier.
 */
export async function registerStandalone(registrar: Registrar, { name, scopes }: { name: string; scopes: readonly string[] }, { mcpOrigin, callback }: { mcpOrigin: string; callback: string }) {
  const identifier = `${mcpOrigin}/${name}/mcp`
  const clientId = `claude-code-${name}`
  await registrar.resource(`mcp-${name}-resource-v1`, { identifier, name, allowedScopes: sorted([...scopes, "offline_access"]), accessTokenTtl: 900 }, true)
  const host = await registrar.client(`${clientId}-v1`, hostClient(clientId, `Claude Code (${name})`, scopes, callback))
  await registrar.link(`${clientId}-link-v1`, clientId, identifier, host)
  return identifier
}
