import type { EnvironmentName, Hosts } from "./environments"

/** The part of `fetch` the smoke test uses; tests pass a fake. */
export type Fetch = (url: string, init: RequestInit) => Promise<Response>

/** How the smoke test runs. */
export type SmokeOptions = {
  fetch: Fetch
  /** Waits between attempts. */
  sleep: (ms: number) => Promise<void>
  /** The clock, in milliseconds. */
  now: () => number
  /** How long failing checks may keep retrying, together. A rollout and a first certificate take a while. */
  timeoutMs: number
  /** The pause between two attempts of one check. */
  intervalMs: number
  /** A request that has not answered by then fails the attempt; defaults to 10 seconds. */
  requestTimeoutMs?: number
}

/** The outcome of one check. */
export type CheckResult = {
  name: string
  url: string
  ok: boolean
  /** What was found, or why the last attempt failed. */
  detail: string
  attempts: number
  /** From the first attempt to the last, in milliseconds. */
  ms: number
}

type Context = {
  /** GET a URL and require status 200. */
  get(url: string): Promise<Response>
  /** GET a URL and require a 200 answer with a JSON object. */
  json(url: string): Promise<Record<string, unknown>>
}

type Check = { name: string; url: string; run(context: Context): Promise<string> }

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

function createContext(options: SmokeOptions): Context {
  const get = async (url: string) => {
    let response: Response
    try {
      response = await options.fetch(url, {
        redirect: "manual",
        cache: "no-store",
        headers: { accept: "application/json", "user-agent": "answerable-smoke" },
        signal: AbortSignal.timeout(options.requestTimeoutMs ?? 10_000),
      })
    } catch (error) {
      throw new Error(`no answer: ${messageOf(error)}`)
    }
    if (response.status !== 200) {
      const location = response.headers.get("location")
      throw new Error(`HTTP ${response.status}${location ? ` redirecting to ${location}` : ""}`)
    }
    return response
  }
  const json = async (url: string) => {
    const response = await get(url)
    let body: unknown
    try {
      body = await response.json()
    } catch {
      throw new Error("the body is not JSON")
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) throw new Error("the body is not a JSON object")
    return body as Record<string, unknown>
  }
  return { get, json }
}

function health(name: string, host: string, path: string): Check {
  const url = `https://${host}${path}`
  return {
    name: `${name} ${path}`,
    url,
    async run(context) {
      const { status } = await context.json(url)
      if (status !== "ok") throw new Error(`status is ${JSON.stringify(status)}, expected "ok"`)
      return 'status "ok"'
    },
  }
}

function resourceMetadata(name: string, host: string, issuer: string): Check {
  const url = `https://${host}/.well-known/oauth-protected-resource/mcp`
  return {
    name: `${name} resource metadata`,
    url,
    async run(context) {
      const body = await context.json(url)
      if (body.resource !== `https://${host}/mcp`)
        throw new Error(`resource is ${JSON.stringify(body.resource)}, expected https://${host}/mcp`)
      const servers = body.authorization_servers
      if (!Array.isArray(servers) || !servers.includes(issuer))
        throw new Error(`authorization_servers is ${JSON.stringify(servers)}, expected it to name ${issuer}`)
      return `names ${issuer}`
    },
  }
}

function checksFor(hosts: Hosts): Check[] {
  const issuer = `https://${hosts.id}`
  const discoveryUrl = `${issuer}/.well-known/openid-configuration`
  return [
    health("id", hosts.id, "/healthz"),
    health("id", hosts.id, "/readyz"),
    {
      name: "id discovery",
      url: discoveryUrl,
      async run(context) {
        const { issuer: found } = await context.json(discoveryUrl)
        if (found !== issuer) throw new Error(`issuer is ${JSON.stringify(found)}, expected ${issuer}`)
        return `issuer ${issuer}`
      },
    },
    {
      name: "id jwks",
      url: `${issuer}/auth/jwks`,
      async run(context) {
        const { jwks_uri: uri } = await context.json(discoveryUrl)
        if (typeof uri !== "string") throw new Error("the discovery document has no jwks_uri")
        if (!URL.canParse(uri)) throw new Error(`jwks_uri "${uri}" is not a URL`)
        if (new URL(uri).origin !== issuer) throw new Error(`jwks_uri ${uri} is not under ${issuer}`)
        const { keys } = await context.json(uri)
        if (!Array.isArray(keys) || keys.length === 0) throw new Error("the key set is empty")
        return `${keys.length} signing key${keys.length === 1 ? "" : "s"}`
      },
    },
    health("toolbox", hosts.toolbox, "/health"),
    resourceMetadata("toolbox", hosts.toolbox, issuer),
    health("admin-mcp", hosts.admin, "/health"),
    resourceMetadata("admin-mcp", hosts.admin, issuer),
  ]
}

/**
 * Check an environment through its public hostnames: ID's health, discovery and signing keys, and the Toolbox's
 * and the admin MCP's health and protected-resource metadata. A failing check is retried until the shared
 * `timeoutMs` has passed, because a rollout and a first certificate take time.
 */
export async function runSmoke(hosts: Hosts, options: SmokeOptions): Promise<CheckResult[]> {
  const context = createContext(options)
  const deadline = options.now() + options.timeoutMs
  const results: CheckResult[] = []
  for (const check of checksFor(hosts)) {
    const started = options.now()
    let attempts = 0
    for (;;) {
      attempts += 1
      try {
        const detail = await check.run(context)
        results.push({ name: check.name, url: check.url, ok: true, detail, attempts, ms: options.now() - started })
        break
      } catch (error) {
        if (options.now() + options.intervalMs > deadline) {
          results.push({ name: check.name, url: check.url, ok: false, detail: messageOf(error), attempts, ms: options.now() - started })
          break
        }
        await options.sleep(options.intervalMs)
      }
    }
  }
  return results
}

/** Whether every check passed. */
export function smokePassed(results: readonly CheckResult[]): boolean {
  return results.every((result) => result.ok)
}

/** The results as a table, ending with a one-line verdict. */
export function formatReport(environment: EnvironmentName, hosts: Hosts, results: readonly CheckResult[]): string {
  const rows = [
    ["CHECK", "RESULT", "TIME", "TRIES", "DETAIL"],
    ...results.map((result) => [
      result.name,
      result.ok ? "PASS" : "FAIL",
      `${result.ms} ms`,
      String(result.attempts),
      result.detail,
    ]),
  ]
  const widths = [0, 1, 2, 3].map((column) => Math.max(...rows.map((row) => row[column]!.length)))
  const table = rows.map((row) => row.map((cell, column) => (column < 4 ? cell.padEnd(widths[column]! + 2) : cell)).join("").trimEnd())
  const failed = results.filter((result) => !result.ok).length
  const verdict =
    failed === 0 ? `PASSED: ${results.length} of ${results.length} checks` : `FAILED: ${failed} of ${results.length} checks failed`
  return [
    `Smoke test of ${environment}: ${hosts.id}, ${hosts.toolbox}, ${hosts.admin}`,
    "",
    ...table,
    "",
    verdict,
    "",
  ].join("\n")
}
