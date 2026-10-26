// The developer's local Answerable ID, as bun mcp setup and bun mcp dev use it: a token for a machine client, the admin API behind a bearer, and the
// registrations an MCP needs, made the way the deploy's register Job makes them (infra/ops/src/register.ts) and safe to make again.
import { adminApi, failure, type Answer, type Call } from "../../infra/ops/src/admin-api"
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

const signIn = ["openid", "offline_access"]
const hostGrants = ["authorization_code", "refresh_token"]
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
export type Held = { created?: Record<string, unknown>; revision: number; resources: string[] }

// The fields of `wanted` whose value differs from what ID holds; lists compare as sets, since ID keeps its own order.
function differences(held: Record<string, unknown>, wanted: Record<string, unknown>) {
  const same = (a: unknown, b: unknown) => (Array.isArray(a) && Array.isArray(b) ? JSON.stringify(sorted(a)) === JSON.stringify(sorted(b)) : JSON.stringify(a) === JSON.stringify(b))
  return Object.fromEntries(Object.entries(wanted).filter(([field, value]) => value !== undefined && !same(held[field], value)))
}

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

/**
 * Resources, clients and links in the local ID, as the register Job makes them: each is read first, created with its `Idempotency-Key` when ID lacks
 * it, and changed with `If-Match` under `<key>-r<revision>` in the fields that differ, scopes and redirect URIs only widening. `tally` counts what it made,
 * changed and found as declared.
 */
export function createRegistrar(call: Call) {
  const tally = { made: 0, changed: 0, found: 0 }
  async function read(path: string) {
    const answer = await call("GET", path)
    if (answer.status === 404) return undefined
    if (!answer.ok) throw failure("GET", path, answer)
    return answer
  }
  /** A write with its key: made; or, as declared already, replayed or, for a create, a conflict. Anything else throws. */
  async function write(method: string, path: string, key: string, body?: unknown, { create = false } = {}) {
    const answer = await call(method, path, { key, body })
    const existed = create && answer.status === 409 && answer.body.code === "conflict"
    if (!answer.ok && !existed) throw failure(method, path, answer, key)
    tally[existed || answer.replayed ? "found" : "made"]++
    return answer.body
  }
  /** Change what differs of a row ID holds, with its ETag, under `<key>-r<revision>`; answers the row's revision afterwards. */
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
    // A replay answers the receipt, whose change moved the revision on by one.
    return (answer.body.revision as number | undefined) ?? (held.body.revision as number) + 1
  }
  return {
    tally,
    /** What the registrar made, changed and found as declared, in words. */
    counts: () => `${tally.made} made, ${tally.changed} changed, ${tally.found} found`,
    read,
    write,
    /** Widen the scopes of a row ID holds, a capability or an entitlement at `path`, to carry `needed` as well, with `If-Match` under `<key>-r<revision>`. */
    async widen(path: string, key: string, needed: readonly string[]) {
      const held = (await read(path))!
      await update(path, key, held, { scopes: sorted([...(held.body.scopes as string[]), ...needed]) })
    },
    /** A resource as declared: created when ID has none, else changed where it differs; its scopes keep what it holds unless `own`, an MCP's own resource, follows its manifest. */
    async resource(key: string, fields: { identifier: string; name: string; allowedScopes: string[]; accessTokenTtl: number }, own = false) {
      const path = `/resources/${encodeURIComponent(fields.identifier)}`
      const held = await read(path)
      if (!held) return void (await write("POST", "/resources", key, { classification: "platform_shared", organizationId: null, ...fields }))
      const holds = held.body.allowedScopes as string[]
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

/** The Toolbox in ID: its resource, its admin resource and Claude Code as its host client, as the register Job registers them. */
export async function registerToolbox(registrar: Registrar, stack: Stack = local) {
  await registrar.resource("toolbox-resource-v1", { identifier: stack.toolboxResource, name: "Toolbox", allowedScopes: ["offline_access", "toolbox"], accessTokenTtl: 900 })
  await registrar.resource("toolbox-admin-resource-v1", { identifier: stack.toolboxAdminResource, name: "Toolbox admin", allowedScopes: ["toolbox:admin"], accessTokenTtl: 300 })
  await registrar.client("claude-code-toolbox-v1", { clientId: "claude-code-toolbox", name: "Claude Code (Toolbox)", tokenEndpointAuthMethod: "none", grantTypes: hostGrants, redirectUris: [stack.callback], scopes: [...signIn, "toolbox"] })
}

/**
 * A standalone MCP in ID, as the register Job registers it: its resource, `<origin>/<name>/mcp`, with its manifest's `scopes` and `offline_access`,
 * its Claude Code client, `claude-code-<name>`, and their link. Answers the resource's identifier.
 */
export async function registerStandalone(registrar: Registrar, { name, scopes }: { name: string; scopes: readonly string[] }, stack: Stack = local) {
  const identifier = `${stack.standalone}/${name}/mcp`
  const clientId = `claude-code-${name}`
  await registrar.resource(`mcp-${name}-resource-v1`, { identifier, name, allowedScopes: sorted([...scopes, "offline_access"]), accessTokenTtl: 900 }, true)
  const host = await registrar.client(`${clientId}-v1`, {
    clientId, name: `Claude Code (${name})`, tokenEndpointAuthMethod: "none", grantTypes: hostGrants, redirectUris: [stack.callback], scopes: [...signIn, ...scopes],
  })
  await registrar.link(`${clientId}-link-v1`, clientId, identifier, host)
  return identifier
}

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
