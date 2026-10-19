import { expect, test } from "bun:test"
import { createKubernetesSecretStore } from "./secret-store"
import { fakeKubernetes } from "./testing"

const url = { secret: "id-database", key: "DATABASE_URL" }

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
