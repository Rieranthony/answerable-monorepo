import { afterAll, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { connect } from "./connect"

// Bun.SQL connects on the first query, so these pools never open a connection: they show what Bun was given. Bun sends the URL's
// parameters it does not know to the server as startup parameters, which Postgres refuses, so sslrootcert must not reach it.
const directory = mkdtempSync(join(tmpdir(), "mcp-postgres-connect-"))
const ca = join(directory, "ca.pem")
writeFileSync(ca, "-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----\n")
afterAll(() => rmSync(directory, { recursive: true, force: true }))
const base = "postgres://runtime:s3cret@db.example:5432/answerable_toolbox"

test("a URL without sslrootcert reaches Bun as it is, with the options", async () => {
  const db = connect(`${base}?sslmode=require`, { max: 2 })
  expect(db.options).toMatchObject({ hostname: "db.example", database: "answerable_toolbox", max: 2, sslMode: 2, tls: { serverName: "db.example" } })
  expect(db.options.tls).not.toHaveProperty("ca")
  await db.close()
})

test("sslrootcert becomes the certificate authority Bun verifies the server against, and sslmode stays Bun's", async () => {
  const full = connect(`${base}?sslmode=verify-full&sslrootcert=${ca}`, { max: 1 })
  expect(full.options).toMatchObject({ hostname: "db.example", max: 1, sslMode: 4, tls: { ca: await Bun.file(ca).text() } })
  expect((full.options as { query?: string }).query).toBe("")
  await full.close()
  const chain = connect(`${base}?sslrootcert=${ca}&sslmode=verify-ca`)
  expect(chain.options).toMatchObject({ sslMode: 3, tls: { ca: await Bun.file(ca).text() } })
  await chain.close()
})

test("sslrootcert without a verifying sslmode is refused, without the URL in the message", () => {
  for (const mode of ["", "&sslmode=require", "&sslmode=prefer"]) {
    const attempt = () => connect(`${base}?sslrootcert=${ca}${mode}`)
    expect(attempt).toThrow("sslrootcert needs sslmode=verify-full or sslmode=verify-ca")
    expect(attempt).not.toThrow("s3cret")
  }
})

test("a missing sslrootcert file is an error naming the file", () => {
  expect(() => connect(`${base}?sslmode=verify-full&sslrootcert=${join(directory, "missing.pem")}`)).toThrow("missing.pem")
})
