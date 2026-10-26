// Test support for bun mcp dev: the local stack in memory. The local ID (the fake of @answerable/id-admin), the Toolbox's health and admin API, the
// standalone server's health, and a start that records each server and brings its health up until it is stopped.
import type { Fetch } from "../io"
import { servers } from "./io"
import type { LocalId } from "./id"

/**
 * `fetch` for every address of the local stack and `start` for the two servers. A server answers `/health` listing `mounted` from the moment it is
 * started until it is stopped or has ended. The Toolbox's enable operation answers `422 unknown_provider` for a provider not in `mounted`, and `401`
 * for a token ID did not issue for its admin resource with `toolbox:admin`; each call is kept in `enabled`.
 */
export function localStack(id: LocalId, { mounted = ["acme"], end, refuse }: {
  mounted?: string[]
  end?: (command: string[], cwd: string) => number | undefined
  /** The Toolbox's admin API answers every enable call with this error. */
  refuse?: { status: number; code: string; message: string }
} = {}) {
  const { start, started } = servers(end)
  const enabled: { organisation: string; body: { hostClientIds: string[]; providers: string[] } }[] = []
  // What the enable operation made, by organisation: repeating it makes nothing.
  const done = new Map<string, Set<string>>()
  const up = (workspace: string) => started.some(server => server.cwd.endsWith(workspace) && !server.stopped && !server.ended)
  const fetch: Fetch = async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    if (url.port === "47300") return id.config.fetch(request)
    const workspace = url.port === "47400" ? "mcps/toolbox" : "mcps/standalone"
    if (url.pathname === "/health") {
      if (!up(workspace)) throw new TypeError("Unable to connect")
      return Response.json({ status: "ok", databases: {}, providers: mounted })
    }
    const enable = /^\/admin\/v1\/organisations\/([^/]+)\/enable$/.exec(url.pathname)
    const token = id.issued(request.headers.get("Authorization")?.slice(7) ?? "")
    if (!enable || token?.resource !== "http://localhost:47400/admin" || !token.scope.split(" ").includes("toolbox:admin")) {
      return Response.json({ error: { code: "unauthorized", message: "A token for the Toolbox's admin resource is required" } }, { status: 401 })
    }
    const body = await request.json() as { hostClientIds: string[]; providers: string[] }
    if (refuse) return Response.json({ error: { code: refuse.code, message: refuse.message } }, { status: refuse.status })
    const unknown = body.providers.filter(provider => !mounted.includes(provider))
    if (unknown.length) return Response.json({ error: { code: "unknown_provider", message: `${unknown.join(", ")} is not mounted in this Toolbox` } }, { status: 422 })
    // The Toolbox allows the grant strings of the providers it enables on its resource in ID.
    const resource = id.resourceOf("http://localhost:47400/mcp")
    resource.allowedScopes = [...new Set([...resource.allowedScopes, ...body.providers])].sort()
    resource.revision++
    enabled.push({ organisation: enable[1]!, body })
    const wanted = [...body.hostClientIds.map(client => `link ${client}`), ...body.providers.map(provider => `catalogue ${provider}`)]
    const held = done.get(enable[1]!) ?? done.set(enable[1]!, new Set()).get(enable[1]!)!
    const created = wanted.filter(step => !held.has(step))
    for (const step of wanted) held.add(step)
    return Response.json({ organisation_id: enable[1], created, existing: wanted.filter(step => !created.includes(step)) })
  }
  return { fetch, start, started, enabled }
}
