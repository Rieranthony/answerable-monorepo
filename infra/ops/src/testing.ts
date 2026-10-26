// Test support for the ops commands: in-memory stand-ins for Kubernetes, ID's admin API, the secret store and the
// database's TLS fetch. Not shipped behaviour.
import { X509Certificate } from "node:crypto"
import { createFakeId } from "@answerable/id-admin/testing"
import type { FetchChain } from "./database-ca"
import type { Kubernetes } from "./kubernetes"
import type { SecretRef, SecretStore } from "./secret-store"

type KubernetesState = { secrets?: Record<string, Record<string, string>>; configMaps?: Record<string, Record<string, string>>; deployments?: Record<string, number> }

/** An in-memory Kubernetes: `secrets`, `configMaps` and `deployments` (replicas by name) are the live state, for a test to read and seed. */
export function fakeKubernetes({ secrets = {}, configMaps = {}, deployments = {} }: KubernetesState = {}) {
  const client: Kubernetes = {
    async readSecret(name) {
      return secrets[name] ? { ...secrets[name] } : undefined
    },
    async writeSecretKey(name, key, value) {
      secrets[name] = { ...secrets[name], [key]: value }
    },
    async readConfigMap(name) {
      return configMaps[name] ? { ...configMaps[name] } : undefined
    },
    async writeConfigMap(name, data) {
      configMaps[name] = { ...configMaps[name], ...data }
    },
    async replicas(name) {
      return deployments[name]
    },
    async setReplicas(name, replicas) {
      if (!(name in deployments)) throw new Error(`Kubernetes answered 404 NotFound to PATCH Deployment ${name}`)
      deployments[name] = replicas
    },
  }
  return { client, secrets, configMaps, deployments }
}

/** The TLS fetch, answering the certificates of `chain` (PEM, leaf first), or failing with it, and recording each host and port it was asked for. */
export function fakeFetchChain(chain: string[] | Error) {
  const calls: string[] = []
  const fetchChain: FetchChain = async (host, port) => {
    calls.push(`${host}:${port}`)
    if (chain instanceof Error) throw chain
    return chain.map(pem => Buffer.from(new X509Certificate(pem).raw))
  }
  return { fetchChain, calls }
}

/**
 * Answerable ID in memory, as the ops commands meet it: `@answerable/id-admin`'s fake at `https://id.example`, with the root secret `root-secret`,
 * which works until a member joins `platform-admins` (seed that group with `group` to run make-admin) or `lockRoot(true)`. `fetch` is its
 * handler, `platform` the platform organisation, and `calls()` every admin request as `{ method, path, key, ifMatch, caller }`, the path
 * without `/api/admin/v1` or its query and the caller `root`, a machine client's id, or `null`.
 */
export function fakeId(options: { breakGlass?: boolean; microsoft?: boolean; platform?: boolean; expiresIn?: number } = {}) {
  const id = createFakeId({ issuer: "https://id.example", rootSecret: "root-secret", clientId: "test-hub", ...options })
  const calls = () => id.received.map(({ request, idempotencyKey, ifMatch, caller }) => {
    const [method, target] = request.split(" ") as [string, string]
    return { method, path: target.replace("/api/admin/v1", "").split("?")[0]!, key: idempotencyKey, ifMatch, caller }
  })
  return Object.assign(id, { fetch: id.config.fetch as typeof globalThis.fetch, rootSecret: "root-secret", platform: id.organizationId, calls })
}
export type FakeId = ReturnType<typeof fakeId>

/** An in-memory secret store whose `values` are keyed `secret/key`, recording every write. */
export function memoryStore(values: Record<string, string> = {}) {
  const writes: string[] = []
  const store: SecretStore = {
    async get({ secret, key }: SecretRef) {
      return values[`${secret}/${key}`] || undefined
    },
    async put({ secret, key }: SecretRef, value: string) {
      writes.push(`${secret}/${key}`)
      values[`${secret}/${key}`] = value
    },
  }
  return { store, values, writes }
}
