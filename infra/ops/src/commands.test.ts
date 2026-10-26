import { expect, test } from "bun:test"
import { existsSync, readFileSync, statSync } from "node:fs"
import { X509Certificate } from "node:crypto"
import type { Sql } from "@answerable/mcp-postgres"
import { main, pgSql } from "./commands"
import { INTERMEDIATE, LEAF, ROOT } from "./test-certificates"
import { fakeFetchChain, fakeIdAdmin, fakeKubernetes } from "./testing"

type Connection = { url: string; ca: string; mode: number }

/** Run the command with fakes; returns the exit code, what it printed and what it reported, and each database connection with the authority file it named. */
async function run(argv: string[], env: Record<string, string>, extra: { kube?: ReturnType<typeof fakeKubernetes>; id?: ReturnType<typeof fakeIdAdmin>; chain?: string[] | Error; failing?: boolean } = {}) {
  const out: string[] = []
  const err: string[] = []
  const statements: string[] = []
  const connections: Connection[] = []
  const kube = extra.kube ?? fakeKubernetes()
  const id = extra.id ?? fakeIdAdmin()
  const fetched = fakeFetchChain(extra.chain ?? [LEAF, INTERMEDIATE, ROOT])
  const sql: Sql = async text => {
    statements.push(text)
    if (extra.failing) throw new Error("the database broke")
    // provisionMcps checks the shared database's owner first.
    return text.startsWith("select datname as name") ? [{ name: "answerable_mcps", owner: "answerable_mcps_migrator" }] : []
  }
  const code = await main(argv, env, {
    database: url => {
      const file = new URL(url).searchParams.get("sslrootcert")!
      connections.push({ url, ca: readFileSync(file, "utf8"), mode: statSync(file).mode & 0o777 })
      return { sql, close: async () => {} }
    },
    kubernetes: () => kube.client,
    fetchChain: fetched.fetchChain,
    fetch: id.fetch,
    log: line => out.push(line),
    error: line => err.push(line),
  })
  return { code, out: out.join("\n"), err: err.join("\n"), statements, connections, kube, id, fetched }
}

const adminUrl = "postgres://dbadmin:pw@db.internal:6432/postgres?sslmode=verify-full&sslrootcert=/etc/ssl/db/ca.pem"
const OPS_MCPS = JSON.stringify([{ name: "e2e", serve: "both", database: "shared" }, { name: "acme", serve: "toolbox", database: "own" }])
// The chart's list as register reads it: with each MCP's scopes.
const registerMcps = JSON.stringify([{ name: "e2e", serve: "both", database: "shared", scopes: ["e2e:read"] }, { name: "acme", serve: "toolbox", database: "own", scopes: ["acme:read"] }])
const registerEnv = { OPS_ID_URL: "https://id.example", OPS_ID_TOKEN: "root-secret", OPS_TOOLBOX_URL: "https://toolbox.example", OPS_ADMIN_MCP_URL: "https://admin-mcp.example", OPS_MCP_URL: "https://mcp.example/", OPS_MCPS: registerMcps }

test("bootstrap fetches the database's authority on first use, writes it to postgres-ca, and verifies the database against it", async () => {
  const { code, connections, kube, statements, fetched, out } = await run(["bootstrap"], { OPS_DATABASE_ADMIN_URL: adminUrl, OPS_MCPS })
  expect(code).toBe(0)
  expect(fetched.calls).toEqual(["db.internal:6432"])
  expect(kube.configMaps["postgres-ca"]).toEqual({ "ca.pem": ROOT })
  expect(out).toContain(`SHA-256:  ${new X509Certificate(ROOT).fingerprint256}`)
  // A connection with the URL's login and verify-full, then one to each database it provisions MCPs in, each with the authority in a file only
  // this process reads, gone afterwards.
  const urls = connections.map(connection => new URL(connection.url))
  expect(urls.map(url => `${url.username}@${url.host}${url.pathname} ${url.searchParams.get("sslmode")}`)).toEqual(
    ["/postgres", "/answerable_mcps", "/answerable_mcp_acme"].map(path => `dbadmin@db.internal:6432${path} verify-full`))
  for (const connection of connections) expect(connection).toMatchObject({ ca: ROOT, mode: 0o600 })
  expect(existsSync(urls[0]!.searchParams.get("sslrootcert")!)).toBe(false)
  expect(statements.some(statement => statement.startsWith('create database "answerable_id"'))).toBe(true)
  expect(statements).toContain('create schema if not exists "e2e" authorization "mcp_e2e_owner"')
  expect(statements).toContain('create schema if not exists "acme" authorization "answerable_mcp_acme_owner"')
  expect(kube.secrets["mcp-acme-database"]!.DATABASE_URL).toStartWith("postgres://answerable_mcp_acme_runtime:")
  // The services' URLs name the address of the administrative URL and the authority where the chart mounts it.
  const service = new URL(kube.secrets["id-database"]!.DATABASE_URL!)
  expect(service.host).toBe("db.internal:6432")
  expect(service.search).toBe("?sslmode=verify-full&sslrootcert=/etc/ssl/db/ca.pem")
})

test("bootstrap uses the authority postgres-ca holds without fetching, the given path in the services' URLs, and an IPv6 host bare", async () => {
  const kube = fakeKubernetes({ configMaps: { "postgres-ca": { "ca.pem": INTERMEDIATE } } })
  const { code, connections, fetched } = await run(["bootstrap"], { OPS_DATABASE_ADMIN_URL: "postgres://a:b@[fd00::5]/postgres?sslmode=verify-full", OPS_DATABASE_SSLROOTCERT: "/ca.pem", OPS_MCPS: "[]" }, { kube })
  expect(code).toBe(0)
  expect(fetched.calls).toEqual([])
  expect(connections[0]!.ca).toBe(INTERMEDIATE)
  expect(new URL(connections[0]!.url).host).toBe("[fd00::5]")
  expect(kube.secrets["toolbox-database"]!.TOOLBOX_DATABASE_URL).toEndWith("@[fd00::5]:5432/answerable_toolbox?sslmode=verify-full&sslrootcert=/ca.pem")
})

test("bootstrap stops before the database when the fetch fails, and removes the authority file when the work fails", async () => {
  const refused = await run(["bootstrap"], { OPS_DATABASE_ADMIN_URL: adminUrl, OPS_MCPS }, { chain: new Error("The database at db.internal:6432 refused TLS") })
  expect(refused.code).toBe(1)
  expect(refused.err).toBe("bootstrap failed: The database at db.internal:6432 refused TLS")
  expect(refused.connections).toEqual([])
  expect(refused.kube.configMaps).toEqual({})
  const broken = await run(["bootstrap"], { OPS_DATABASE_ADMIN_URL: adminUrl, OPS_MCPS }, { failing: true })
  expect(broken.code).toBe(1)
  expect(broken.err).toBe("bootstrap failed: the database broke")
  expect(existsSync(new URL(broken.connections[0]!.url).searchParams.get("sslrootcert")!)).toBe(false)
})

test("register registers in ID, with each standalone MCP of the list, stores the client secrets, then starts the servers that were waiting at zero replicas", async () => {
  const kube = fakeKubernetes({ deployments: { toolbox: 0, "admin-mcp": 0, standalone: 0, other: 3 } })
  const { code, out, id } = await run(["register"], { ...registerEnv, OPS_START_DEPLOYMENTS: "toolbox=2, admin-mcp=1,standalone=2,other=1,missing=1" }, { kube })
  expect(code).toBe(0)
  expect(Object.keys(kube.secrets).sort()).toEqual(["admin-id-client", "ops-id-client", "standalone-id-client", "toolbox-id-client"])
  expect(id.state.resources.get("https://mcp.example/e2e/mcp")!.allowedScopes).toEqual(["e2e:read", "offline_access"])
  expect(id.state.clients.has("claude-code-acme")).toBe(false)
  expect(kube.deployments).toEqual({ toolbox: 2, "admin-mcp": 1, standalone: 2, other: 3 })
  expect(out).toContain("toolbox: scaled from 0 to 2")
  expect(out).toContain("other: already running")
  expect(out).toContain("missing: no such Deployment")
  expect(id.state.domains.size).toBe(0)
})

test("register uses the platform slug, the callback port and the staff directory when given", async () => {
  const { code, out, id } = await run(["register"], { ...registerEnv, OPS_PLATFORM_SLUG: "staff", OPS_CLAUDE_CALLBACK_PORT: "47701", OPS_STAFF_DOMAIN: "Answerable.org", OPS_ENTRA_TENANT: "0B1C2D3E-4F50-6172-8394-A5B6C7D8E9F0" }, { id: fakeIdAdmin({ platformSlug: "staff" }) })
  expect(code).toBe(0)
  expect(out).toContain("--callback-port 47701")
  expect(id.state.domains.has("answerable.org")).toBe(true)
  expect(id.state.ssoProvider).toEqual({ issuer: "https://login.microsoftonline.com/0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0/v2.0", domain: "answerable.org" })
})

test("register mints its client with ID's root secret when no staff token is given, with the staff token over it when both are, and then with neither", async () => {
  const { OPS_ID_TOKEN: root, ...withoutToken } = registerEnv
  const callers = (result: Awaited<ReturnType<typeof run>>) => new Set(result.id.state.calls.map(call => result.id.caller(call)))
  const kube = fakeKubernetes()
  const fromRoot = await run(["register"], { ...withoutToken, OPS_ID_ROOT_SECRET: root }, { kube })
  expect(fromRoot.code).toBe(0)
  expect(callers(fromRoot)).toEqual(new Set(["root", "ops-register"]))
  const fromStaff = await run(["register"], { ...registerEnv, OPS_ID_TOKEN: "a-staff-token", OPS_ID_ROOT_SECRET: root })
  expect(fromStaff.code).toBe(0)
  expect(callers(fromStaff)).toEqual(new Set(["a-staff-token", "ops-register"]))
  // Its client's secret is in ops-id-client now: neither is needed.
  const alone = await run(["register"], withoutToken, { kube, id: fromRoot.id })
  expect(alone.code).toBe(0)
  expect(alone.out).toContain("Registering as ops-register, register's own machine client")
})

test("make-admin puts the member with the email in the owner and platform-admins groups with the root secret", async () => {
  const id = fakeIdAdmin()
  id.state.groups.set("answerable-owner", "owner-group")
  id.state.members.set("member-1", "you@answerable.org")
  const { code, out } = await run(["make-admin"], { OPS_ID_URL: "https://id.example/", OPS_ID_ROOT_SECRET: id.rootSecret, OPS_ADMIN_EMAIL: "you@answerable.org" }, { id })
  expect(code).toBe(0)
  expect(out).toContain("Root is locked now")
  expect(id.state.rootLocked).toBe(true)
})

test("a missing or invalid variable is named, with exit code 2, before anything is done", async () => {
  const missing = await run(["bootstrap"], { NODE_ENV: "production" })
  expect(missing).toMatchObject({ code: 2, statements: [] })
  expect(missing.err).toStartWith("Invalid ops configuration: OPS_DATABASE_ADMIN_URL: ")
  expect(missing.err).toContain("OPS_MCPS: ")
  const badList = await run(["bootstrap"], { OPS_DATABASE_ADMIN_URL: adminUrl, OPS_MCPS: '[{"name":"Acme","serve":"toolbox","database":"shared"}]' })
  expect(badList).toMatchObject({ code: 2, statements: [] })
  expect(badList.err).toContain("OPS_MCPS: Expected an MCP's name")
  const unverified = await run(["bootstrap"], { OPS_DATABASE_ADMIN_URL: "postgres://a:b@db/postgres?sslmode=require", OPS_MCPS })
  expect(unverified).toMatchObject({ code: 2, err: "Invalid ops configuration: OPS_DATABASE_ADMIN_URL: Must ask for sslmode=verify-full" })
  expect(unverified.fetched.calls).toEqual([])
  const noList = await run(["register"], { ...registerEnv, OPS_MCPS: '[{"name":"e2e","serve":"both"}]' })
  expect(noList.code).toBe(2)
  expect(noList.err).toContain("OPS_MCPS: ")
  const notJson = await run(["register"], { ...registerEnv, OPS_MCPS: "e2e" })
  expect(notJson.err).toContain("OPS_MCPS: Expected the chart's list of MCPs as JSON")
  const badStart = await run(["register"], { ...registerEnv, OPS_START_DEPLOYMENTS: "toolbox" })
  expect(badStart.err).toContain("OPS_START_DEPLOYMENTS")
  const halfStaff = await run(["register"], { ...registerEnv, OPS_STAFF_DOMAIN: "answerable.org" })
  expect(halfStaff).toMatchObject({ code: 2, err: "Invalid ops configuration: OPS_ENTRA_TENANT: OPS_STAFF_DOMAIN and OPS_ENTRA_TENANT go together: set both or neither" })
  const badStaff = await run(["register"], { ...registerEnv, OPS_STAFF_DOMAIN: "not a domain", OPS_ENTRA_TENANT: "tenant" })
  expect(badStaff.err).toContain("OPS_STAFF_DOMAIN: Expected a domain such as answerable.org")
  expect(badStaff.err).toContain("OPS_ENTRA_TENANT: Expected the tenant's ID, a GUID")
  const noEmail = await run(["make-admin"], { OPS_ID_URL: "https://id.example", OPS_ID_ROOT_SECRET: "root-secret", OPS_ADMIN_EMAIL: "you" })
  expect(noEmail.code).toBe(2)
  expect(noEmail.err).toContain("OPS_ADMIN_EMAIL")
  const noRoot = await run(["make-admin"], { NODE_ENV: "production", OPS_ID_URL: "https://id.example", OPS_ADMIN_EMAIL: "you@answerable.org" })
  expect(noRoot.err).toStartWith("Invalid ops configuration: OPS_ID_ROOT_SECRET: ")
  expect([...noEmail.id.state.calls, ...noRoot.id.state.calls]).toEqual([])
  const usage = await run(["deploy"], {})
  expect(usage).toMatchObject({ code: 2, err: "Usage: cli.ts bootstrap, register, make-admin" })
})

test("a failure is printed without its stack and exits 1", async () => {
  const { code, err } = await run(["register"], registerEnv, { id: fakeIdAdmin({ rootLocked: true }) })
  expect(code).toBe(1)
  expect(err).toStartWith("register failed: register has no machine client of its own yet (the Secret ops-id-client is empty), and ID refuses the root secret (root_locked)")
  // An empty value is unset: no staff token, and no root secret either.
  const nothing = await run(["register"], { ...registerEnv, OPS_ID_TOKEN: "" })
  expect(nothing).toMatchObject({ code: 1 })
  expect(nothing.err).toContain("and no root secret or staff token to mint one")
  const signedOut = await run(["make-admin"], { OPS_ID_URL: "https://id.example", OPS_ID_ROOT_SECRET: "root-secret", OPS_ADMIN_EMAIL: "you@answerable.org" })
  expect(signedOut.code).toBe(1)
  expect(signedOut.err).toStartWith("make-admin failed: No member of the platform organisation has the email you@answerable.org")
})

test("the database connection is a pg pool through connect, verifying the URL's sslrootcert, with one connection held until it closes", async () => {
  const database = pgSql("postgres://nobody:x@127.0.0.1:1/postgres")
  await expect(database.sql("select 1")).rejects.toThrow()
  await database.close()
  // Closed before any statement, it never connects.
  await pgSql("postgres://nobody:x@127.0.0.1:1/postgres").close()
})
