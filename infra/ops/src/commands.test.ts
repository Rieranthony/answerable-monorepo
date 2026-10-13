import { afterAll, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Sql } from "./bootstrap"
import { bunSql, main } from "./commands"
import { fakeIdAdmin, fakeKubernetes } from "./testing"

const directory = mkdtempSync(join(tmpdir(), "infra-ops-cli-"))
afterAll(() => rmSync(directory, { recursive: true, force: true }))

/** Run the command with fakes; returns the exit code, what it printed and what it reported. */
async function run(argv: string[], env: Record<string, string>, extra: { kube?: ReturnType<typeof fakeKubernetes>; id?: ReturnType<typeof fakeIdAdmin> } = {}) {
  const out: string[] = []
  const err: string[] = []
  const statements: string[] = []
  const urls: string[] = []
  const kube = extra.kube ?? fakeKubernetes()
  const id = extra.id ?? fakeIdAdmin()
  const sql: Sql = async text => (statements.push(text), [])
  const code = await main(argv, env, {
    database: url => (urls.push(url), { sql, close: async () => {} }),
    kubernetes: () => kube.client,
    fetch: id.fetch,
    log: line => out.push(line),
    error: line => err.push(line),
  })
  return { code, out: out.join("\n"), err: err.join("\n"), statements, urls, kube, id }
}

const adminUrl = "postgres://dbadmin:pw@db.internal:6432/postgres?sslmode=verify-full&sslrootcert=/etc/ssl/db/ca.pem"
const registerEnv = { OPS_ID_URL: "https://id.example", OPS_ID_TOKEN: "root-secret", OPS_TOOLBOX_URL: "https://toolbox.example", OPS_ADMIN_MCP_URL: "https://admin-mcp.example" }

test("bootstrap connects with the administrative URL and writes the services' URLs to Kubernetes, with the host and port taken from it", async () => {
  const { code, urls, kube, statements } = await run(["bootstrap"], { OPS_DATABASE_ADMIN_URL: adminUrl })
  expect(code).toBe(0)
  expect(urls).toEqual([adminUrl])
  expect(statements.some(statement => statement.startsWith('create database "answerable_id"'))).toBe(true)
  const url = new URL(kube.secrets["id-database"]!.DATABASE_URL!)
  expect(url.host).toBe("db.internal:6432")
  expect(url.search).toBe("?sslmode=verify-full&sslrootcert=/etc/ssl/db/ca.pem")
})

test("bootstrap takes the host, port and certificate authority path when given, and a file store outside a cluster", async () => {
  const path = join(directory, "secrets.json")
  const { code } = await run(["bootstrap"], { OPS_DATABASE_ADMIN_URL: "postgres://a:b@db.internal/postgres", OPS_DATABASE_HOST: "private.db", OPS_DATABASE_PORT: "5433", OPS_DATABASE_SSLROOTCERT: "/ca.pem", OPS_STORE: "file", OPS_SECRETS_FILE: path })
  expect(code).toBe(0)
  expect((await Bun.file(path).json())["toolbox-database"].TOOLBOX_DATABASE_URL).toStartWith("postgres://answerable_toolbox_runtime:")
  expect((await Bun.file(path).json())["toolbox-database"].TOOLBOX_DATABASE_URL).toEndWith("@private.db:5433/answerable_toolbox?sslmode=verify-full&sslrootcert=/ca.pem")
})

test("register registers in ID, stores the client secrets, then starts the servers that were waiting at zero replicas", async () => {
  const kube = fakeKubernetes({ deployments: { toolbox: 0, "admin-mcp": 0, other: 3 } })
  const { code, out } = await run(["register"], { ...registerEnv, OPS_START_DEPLOYMENTS: "toolbox=2, admin-mcp=1,other=1,missing=1" }, { kube })
  expect(code).toBe(0)
  expect(Object.keys(kube.secrets).sort()).toEqual(["admin-id-client", "toolbox-id-client"])
  expect(kube.deployments).toEqual({ toolbox: 2, "admin-mcp": 1, other: 3 })
  expect(out).toContain("toolbox: scaled from 0 to 2")
  expect(out).toContain("other: already running")
  expect(out).toContain("missing: no such Deployment")
})

test("register uses the platform slug and callback port when given", async () => {
  const { code, out } = await run(["register"], { ...registerEnv, OPS_PLATFORM_SLUG: "staff", OPS_CLAUDE_CALLBACK_PORT: "47701" }, { id: fakeIdAdmin({ platformSlug: "staff" }) })
  expect(code).toBe(0)
  expect(out).toContain("--callback-port 47701")
})

test("register takes ID's root secret when no staff token is given, and the staff token over it when both are", async () => {
  const { OPS_ID_TOKEN: root, ...withoutToken } = registerEnv
  const fromRoot = await run(["register"], { ...withoutToken, OPS_ID_ROOT_SECRET: root })
  expect(fromRoot.code).toBe(0)
  expect(new Set(fromRoot.id.state.calls.map(call => call.token))).toEqual(new Set([root]))
  const fromStaff = await run(["register"], { ...registerEnv, OPS_ID_TOKEN: "a-staff-token", OPS_ID_ROOT_SECRET: root })
  expect(fromStaff.code).toBe(0)
  expect(new Set(fromStaff.id.state.calls.map(call => call.token))).toEqual(new Set(["a-staff-token"]))
})

test("a missing or invalid variable is named, with exit code 2, before anything is done", async () => {
  const missing = await run(["bootstrap"], {})
  expect(missing).toMatchObject({ code: 2, statements: [] })
  expect(missing.err).toContain("OPS_DATABASE_ADMIN_URL")
  const noToken = await run(["register"], { ...registerEnv, OPS_ID_TOKEN: "" })
  expect(noToken.code).toBe(2)
  expect(noToken.err).toBe("OPS_ID_TOKEN: Required: a staff token, or ID's root secret as OPS_ID_ROOT_SECRET")
  const badStart = await run(["register"], { ...registerEnv, OPS_START_DEPLOYMENTS: "toolbox" })
  expect(badStart.err).toContain("OPS_START_DEPLOYMENTS")
  const noFile = await run(["bootstrap"], { OPS_DATABASE_ADMIN_URL: adminUrl, OPS_STORE: "file" })
  expect(noFile.err).toContain("OPS_SECRETS_FILE")
  const usage = await run(["deploy"], {})
  expect(usage).toMatchObject({ code: 2 })
  expect(usage.err).toContain("bootstrap or register")
})

test("a failure is printed without its stack and exits 1", async () => {
  const { code, err } = await run(["register"], registerEnv, { id: fakeIdAdmin({ rootLocked: true }) })
  expect(code).toBe(1)
  expect(err).toBe("register failed: ID refused the root secret (root_locked): a platform administrator exists. Pass a staff token as OPS_ID_TOKEN (docs/id/onboard#get-a-staff-token)")
})

test("the database connection is Bun.SQL through connect, verifying the URL's sslrootcert, with one connection", async () => {
  const database = bunSql("postgres://nobody:x@127.0.0.1:1/postgres")
  await expect(database.sql("select 1")).rejects.toThrow()
  await database.close()
})
