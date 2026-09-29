import type { SQL } from "bun"
import { createIdVerifier } from "@answerable/auth"
import type { IdVerifierConfig, Provider } from "@answerable/mcp"
import { z } from "zod"
import { createCatalogueAdmin } from "./admin-catalogue"
import { createEnable } from "./admin-enable"
import type { createEvidence } from "./evidence"
import type { IdConfig } from "./id"
import { Problem } from "./problem"

/** The Toolbox's admin resource: the audience of its admin API's tokens, the origin of the Toolbox's resource URL and `/admin`. */
export const toolboxAdminResource = (resource: string) => new URL("/admin", resource).href

const challenges: Record<number, string> = { 401: 'Bearer realm="toolbox-admin"', 403: 'Bearer error="insufficient_scope", scope="toolbox:admin"' }
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
  providers: readonly Provider[]
  id: IdConfig
  evidence: ReturnType<typeof createEvidence>
}) {
  const audience = toolboxAdminResource(auth.resource)
  const verify = createIdVerifier({ ...auth, resource: audience, subjectTypes: ["client"] })
  const admin = createCatalogueAdmin(db, providers)
  const enable = createEnable({ db, providers, id, resource: auth.resource })
  const routes: Route[] = [
    ["GET", /^\/providers$/, async () => admin.providers()],
    ["GET", /^\/organisations\/([^/]+)\/catalogue$/, async ([organisationId]) => admin.catalogue(organisation(organisationId!))],
    ["PUT", /^\/organisations\/([^/]+)\/catalogue\/([^/]+)$/, async ([organisationId, provider], body) => admin.putCatalogue(organisation(organisationId!), provider!, await body())],
    ["POST", /^\/organisations\/([^/]+)\/enable$/, async ([organisationId], body) => enable(organisation(organisationId!), await body())],
    ["GET", /^\/organisations\/([^/]+)\/evidence\/verify$/, async ([organisationId]) => evidence.verify(organisation(organisationId!))],
    ["GET", /^\/host-clients$/, async () => admin.hostClients()],
    ["PUT", /^\/host-clients\/([^/]+)$/, async ([client], body) => admin.putHostClient(client!, await body())],
    ["DELETE", /^\/host-clients\/([^/]+)$/, async ([client]) => admin.removeHostClient(client!)],
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
