import { afterAll, expect, test } from "bun:test"
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createFileSecretStore, createKubernetesSecretStore } from "./secret-store"
import { fakeKubernetes } from "./testing"

const directory = mkdtempSync(join(tmpdir(), "infra-ops-secrets-"))
afterAll(() => rmSync(directory, { recursive: true, force: true }))
const url = { secret: "id-database", key: "DATABASE_URL" }

test("the file store keeps each Secret's keys in one JSON file only its owner can read", async () => {
  const path = join(directory, "secrets.json")
  const store = createFileSecretStore(path)
  expect(await store.get(url)).toBeUndefined()
  await store.put(url, "postgres://runtime:one@db/answerable_id")
  await store.put({ secret: "id-database", key: "OTHER" }, "two")
  await store.put({ secret: "toolbox-id-client", key: "TOOLBOX_ID_CLIENT_SECRET" }, "three")
  expect(await store.get(url)).toBe("postgres://runtime:one@db/answerable_id")
  expect(await Bun.file(path).json()).toEqual({ "id-database": { DATABASE_URL: "postgres://runtime:one@db/answerable_id", OTHER: "two" }, "toolbox-id-client": { TOOLBOX_ID_CLIENT_SECRET: "three" } })
  expect(statSync(path).mode & 0o777).toBe(0o600)
  // An empty value is no value, as an empty Secret key is.
  writeFileSync(path, JSON.stringify({ "id-database": { DATABASE_URL: "" } }))
  expect(await store.get(url)).toBeUndefined()
})

test("the Kubernetes store reads a key of a named Secret, and a missing Secret, key or empty value is no value", async () => {
  const kube = fakeKubernetes({ secrets: { "id-database": { DATABASE_URL: "postgres://x", EMPTY: "" } } })
  const store = createKubernetesSecretStore(kube.client)
  expect(await store.get(url)).toBe("postgres://x")
  expect(await store.get({ secret: "id-database", key: "MISSING" })).toBeUndefined()
  expect(await store.get({ secret: "id-database", key: "EMPTY" })).toBeUndefined()
  expect(await store.get({ secret: "admin-database", key: "ADMIN_DATABASE_URL" })).toBeUndefined()
})

test("the Kubernetes store patches the key into an existing Secret and creates a missing one, keeping the other keys", async () => {
  const kube = fakeKubernetes({ secrets: { "id-database": { KEEP: "kept" } } })
  const store = createKubernetesSecretStore(kube.client)
  await store.put(url, "postgres://new")
  await store.put({ secret: "toolbox-id-client", key: "TOOLBOX_ID_CLIENT_SECRET" }, "s3cret")
  expect(kube.secrets).toEqual({ "id-database": { KEEP: "kept", DATABASE_URL: "postgres://new" }, "toolbox-id-client": { TOOLBOX_ID_CLIENT_SECRET: "s3cret" } })
})
