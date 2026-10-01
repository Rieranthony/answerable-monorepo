import type { SQL } from "bun"
import { createIdVerifier } from "@answerable/auth"
import type { IdAdmin } from "@answerable/id-admin"
import { manifest, type IdVerifierConfig, type Provider } from "@answerable/mcp"
import type { createEvidence } from "@answerable/mcp-postgres"
import { z } from "zod"
import { createEnable } from "./admin-enable"
import { hostClientSettings, listHostClients, overridesSchema, readCatalogue, removeHostClient, writeCatalogue, writeHostClient } from "./catalogue"
import { parse, Problem } from "./problem"

/** The Toolbox's admin resource: the audience of its admin API's tokens, the origin of the Toolbox's resource URL and `/admin`. */
export const toolboxAdminResource = (resource: string) => new URL("/admin", resource).href

const challenges: Record<number, string> = { 401: 'Bearer realm="toolbox-admin"', 403: 'Bearer error="insufficient_scope", scope="toolbox:admin"' }
const catalogueEntry = z.object({ enabled: z.boolean(), overrides: overridesSchema.optional() }).strict()
type Route = [method: string, path: RegExp, run: (params: string[], body: () => Promise<unknown>) => Promise<unknown>]

function organisation(value: string) {
  if (!z.uuid().safeParse(value).success) throw new Problem(400, "invalid_request", `The organisation id ${value} is not a UUID`)
  return value
}
function decode(part: string) {
  try {
    return decodeURIComponent(part)
  } catch {
    throw new Problem(400, "invalid_request", `${part} is not valid percent-encoding`)
  }
}

/**
 * The platform-tier admin API, under `/admin/v1`: JSON in and out, callable with a machine client's token for the admin resource that carries
 * `toolbox:admin`. A failure answers `{ error: { code, message } }`. Returns the handler for a request whose path is under `/admin/v1`.
 */
export function createAdmin({ auth, db, providers, id, evidence }: {
  auth: IdVerifierConfig
  db: SQL
  /** The mounted providers, in the order `GET /providers` lists them. */
  providers: readonly Provider[]
  id: IdAdmin
  evidence: ReturnType<typeof createEvidence>
}) {
  const audience = toolboxAdminResource(auth.resource)
  const verify = createIdVerifier({ ...auth, resource: audience, subjectType: "client" })
  const enable = createEnable({ db, providers, id, resource: auth.resource })
  // Each mounted provider as its manifest says: its reads and mutations, without the commit tools.
  const offered = new Map(providers.map(provider => [provider.id, {
    id: provider.id,
    version: provider.version,
    capabilities: manifest(provider).tools.flatMap(tool => tool.kind === "commit" ? [] : [{
      identity: tool.identity, version: tool.version, kind: tool.kind, risk: tool.kind === "mutate" ? tool.risk : null, title: tool.title ?? null,
    }]),
  }]))
  // Replace an organisation's entry for a provider: overrides name capabilities the provider has, and a policy class only for its mutations.
  async function putCatalogue(organisationId: string, providerId: string, body: unknown) {
    const provider = offered.get(providerId)
    if (!provider) throw new Problem(404, "provider_not_found", `${providerId} is not mounted in this Toolbox; GET /admin/v1/providers lists what is`)
    const { enabled, overrides } = parse(catalogueEntry, body)
    const kinds = new Map(provider.capabilities.map(capability => [capability.identity, capability.kind]))
    const classes = Object.keys(overrides?.policy_class ?? {})
    const unknown = [...(overrides?.disabled ?? []), ...classes].filter(identity => !kinds.has(identity))
    if (unknown.length) throw new Problem(422, "unknown_capability", `${providerId} has no capability ${unknown.join(", ")}; GET /admin/v1/providers lists them`)
    const read = classes.find(identity => kinds.get(identity) === "read")
    if (read) throw new Problem(422, "not_a_mutation", `${read} is a read; a policy class applies to mutations`)
    return { provider_id: providerId, ...await writeCatalogue(db, organisationId, providerId, { enabled, overrides }) }
  }
  const routes: Route[] = [
    ["GET", /^\/providers$/, async () => ({ items: [...offered.values()] })],
    ["GET", /^\/organisations\/([^/]+)\/catalogue$/, async ([organisationId]) => ({
      items: [...await readCatalogue(db, organisation(organisationId!))].map(([provider_id, entry]) => ({ provider_id, ...entry })),
    })],
    ["PUT", /^\/organisations\/([^/]+)\/catalogue\/([^/]+)$/, async ([organisationId, provider], body) => putCatalogue(organisation(organisationId!), provider!, await body())],
    ["POST", /^\/organisations\/([^/]+)\/enable$/, async ([organisationId], body) => enable(organisation(organisationId!), await body())],
    ["GET", /^\/organisations\/([^/]+)\/evidence\/verify$/, async ([organisationId]) => evidence.verify(organisation(organisationId!))],
    ["GET", /^\/host-clients$/, async () => ({ items: await listHostClients(db) })],
    ["PUT", /^\/host-clients\/([^/]+)$/, async ([client], body) => writeHostClient(db, client!, parse(hostClientSettings, await body()))],
    ["DELETE", /^\/host-clients\/([^/]+)$/, async ([client]) => {
      if (!await removeHostClient(db, client!)) throw new Problem(404, "host_client_not_found", `There is no host client ${client}; GET /admin/v1/host-clients lists them`)
    }],
  ]
  async function respond(request: Request) {
    const token = /^Bearer +(\S+)$/i.exec(request.headers.get("Authorization") ?? "")?.[1]
    const principal = token ? await verify(token).catch(() => undefined) : undefined
    if (!principal) throw new Problem(401, "unauthorized", `Send a machine client's access token for ${audience} as Authorization: Bearer`)
    if (!principal.scopes.includes("toolbox:admin")) throw new Problem(403, "forbidden", "The token lacks the toolbox:admin scope; ask Answerable ID for a token with scope=toolbox:admin")
    const { pathname } = new URL(request.url)
    const path = pathname.slice("/admin/v1".length)
    for (const [method, pattern, run] of routes) {
      const match = request.method === method ? pattern.exec(path) : null
      if (!match) continue
      const body = async () => {
        try {
          return await request.json()
        } catch {
          throw new Problem(400, "invalid_request", "The body must be JSON")
        }
      }
      const json = await run(match.slice(1).map(decode), body)
      return json === undefined ? new Response(null, { status: 204 }) : Response.json(json)
    }
    throw new Problem(404, "not_found", `There is no route ${request.method} ${pathname}`)
  }
  return async function handle(request: Request) {
    try {
      const response = await respond(request)
      response.headers.set("Cache-Control", "no-store")
      return response
    } catch (error) {
      if (!(error instanceof Problem)) console.error("[toolbox] admin API failed", error)
      const { status, code, message } = error instanceof Problem ? error : new Problem(500, "internal_error", "The Toolbox failed to answer; its log says why")
      return Response.json({ error: { code, message } }, { status, headers: { "Cache-Control": "no-store", ...(challenges[status] ? { "WWW-Authenticate": challenges[status] } : {}) } })
    }
  }
}
