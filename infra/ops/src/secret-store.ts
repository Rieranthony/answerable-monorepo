import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import type { Kubernetes } from "./kubernetes"

/** One value: a key of a named Secret, as the chart's Deployments and Jobs read it (`id-database`, `DATABASE_URL`). */
export type SecretRef = { secret: string; key: string }

/** Where the ops commands keep what they generate. A missing or empty value is undefined. Implementations never log a value. */
export type SecretStore = {
  get(ref: SecretRef): Promise<string | undefined>
  put(ref: SecretRef, value: string): Promise<void>
}

/** Kubernetes Secrets in the release's namespace, through the API server: where the services read them (D23). */
export function createKubernetesSecretStore(kube: Kubernetes): SecretStore {
  return {
    async get({ secret, key }) {
      return (await kube.readSecret(secret))?.[key] || undefined
    },
    put: ({ secret, key }, value) => kube.writeSecretKey(secret, key, value),
  }
}

/** A JSON file of `{ secret: { key: value } }`, readable by its owner only: for running the commands outside a cluster. */
export function createFileSecretStore(path: string): SecretStore {
  const read = (): Record<string, Record<string, string>> => (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {})
  return {
    async get({ secret, key }) {
      return read()[secret]?.[key] || undefined
    },
    async put({ secret, key }, value) {
      const all = read()
      all[secret] = { ...all[secret], [key]: value }
      writeFileSync(path, JSON.stringify(all, null, 2), { mode: 0o600 })
      chmodSync(path, 0o600)
    },
  }
}
