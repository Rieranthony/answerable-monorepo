import { afterAll, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Client } from "pg"
import { connect } from "./connect"

// A pg pool connects on the first query, so nothing here opens a connection: a client made from the pool's options shows what pg read from the
// URL, which is what every client of the pool connects with.
const directory = mkdtempSync(join(tmpdir(), "mcp-postgres-connect-"))
const ca = join(directory, "ca.pem")
const pem = "-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----\n"
writeFileSync(ca, pem)
afterAll(() => rmSync(directory, { recursive: true, force: true }))
const base = "postgres://runtime:s3cret@db.example:5432/answerable_toolbox"
type Parameters = { host: string; port: number; database: string; user: string; ssl: boolean | { ca?: string; rejectUnauthorized?: boolean; checkServerIdentity?: unknown } }
const parameters = (db: ReturnType<typeof connect>) => (new Client(db.$client.options) as unknown as { connectionParameters: Parameters }).connectionParameters

test("a URL without sslrootcert reaches pg as it is, with the options", async () => {
  const db = connect(`${base}?sslmode=verify-full`, { max: 2 })
  expect(db.$client.options).toMatchObject({ connectionString: `${base}?sslmode=verify-full`, max: 2 })
  const read = parameters(db)
  expect(read).toMatchObject({ host: "db.example", port: 5432, database: "answerable_toolbox", user: "runtime", ssl: {} })
  expect(read.ssl).not.toHaveProperty("ca")
  await db.$client.end()
})

test("sslrootcert becomes the certificate authority pg verifies the server against, under verify-full or verify-ca", async () => {
  const full = connect(`${base}?sslmode=verify-full&sslrootcert=${ca}`, { max: 1 })
  expect(parameters(full)).toMatchObject({ host: "db.example", ssl: { ca: pem } })
  expect(parameters(full).ssl).not.toHaveProperty("rejectUnauthorized")
  expect(parameters(full).ssl).not.toHaveProperty("checkServerIdentity")
  await full.$client.end()
  // pg 8 verifies fully under verify-ca too, and warns once per process when a client parses the URL, so only the pool is made here.
  const chain = connect(`${base}?sslrootcert=${ca}&sslmode=verify-ca`)
  expect(chain.$client.options.connectionString).toBe(`${base}?sslrootcert=${ca}&sslmode=verify-ca`)
  await chain.$client.end()
})

test("sslrootcert without a verifying sslmode is refused, without the URL in the message", () => {
  for (const mode of ["", "&sslmode=require", "&sslmode=prefer"]) {
    const message = mode ? `sslrootcert needs sslmode=verify-full or sslmode=verify-ca, not ${mode.slice(1)}` : "sslrootcert needs sslmode=verify-full or sslmode=verify-ca, not no sslmode"
    expect(() => connect(`${base}?sslrootcert=${ca}${mode}`)).toThrow(message)
    try {
      connect(`${base}?sslrootcert=${ca}${mode}`)
    } catch (error) {
      expect((error as Error).message).not.toContain("s3cret")
    }
  }
})
