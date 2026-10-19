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
