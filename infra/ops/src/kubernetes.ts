import { readFileSync } from "node:fs"
import { join } from "node:path"

/** The few calls the ops Jobs make to the Kubernetes API, in their own namespace. */
export type Kubernetes = {
  /** A Secret's keys, decoded; undefined when the Secret does not exist. */
  readSecret(name: string): Promise<Record<string, string> | undefined>
  /** Write one key of a Secret, creating the Secret when it does not exist; its other keys stay. */
  writeSecretKey(name: string, key: string, value: string): Promise<void>
  /** A ConfigMap's data; undefined when the ConfigMap does not exist. */
  readConfigMap(name: string): Promise<Record<string, string> | undefined>
  /** Write keys of a ConfigMap, creating the ConfigMap when it does not exist; its other keys stay. */
  writeConfigMap(name: string, data: Record<string, string>): Promise<void>
  /** A Deployment's desired replicas (1 when unset, as Kubernetes defaults it); undefined when it does not exist. */
  replicas(name: string): Promise<number | undefined>
  /** Set a Deployment's desired replicas. */
  setReplicas(name: string, replicas: number): Promise<void>
}

type Options = {
  /** The API server, `https://<host>:<port>`. */
  server: string
  /** The ServiceAccount's bearer token. */
  token: string
  /** The cluster's certificate authority, PEM. */
  ca: string
  namespace: string
  fetch?: typeof globalThis.fetch
  /** How long one call may take before it fails naming the object. */
  timeoutMs?: number
}

const encode = (value: string) => Buffer.from(value).toString("base64")
// The name Kubernetes records as the writer of each field the Jobs set (managedFields), such as a Deployment's replicas.
const asOps = "fieldManager=answerable-ops"
const decode = (value: string) => Buffer.from(value, "base64").toString()

/** A client for the API server over HTTPS, verified against the cluster's certificate authority. Errors name the object and the status, never a value. */
export function createKubernetes({ server, token, ca, namespace, fetch = globalThis.fetch, timeoutMs = 30_000 }: Options): Kubernetes {
  const secrets = `${server}/api/v1/namespaces/${namespace}/secrets`
  const configMaps = `${server}/api/v1/namespaces/${namespace}/configmaps`
  const deployments = `${server}/apis/apps/v1/namespaces/${namespace}/deployments`
  async function call(method: string, url: string, body?: unknown) {
    return fetch(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": method === "PATCH" ? "application/merge-patch+json" : "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      tls: { ca },
      signal: AbortSignal.timeout(timeoutMs),
    } as RequestInit).catch((error: Error) => {
      // Behind a NetworkPolicy that admits no route to the API server, a call waits rather than failing.
      throw error.name === "TimeoutError" ? new Error(`The Kubernetes API did not answer ${method} ${new URL(url).pathname} within ${timeoutMs / 1000} s: can this pod reach ${server} (networkPolicy.kubernetesApi)?`) : error
    })
  }
  async function refusal(response: Response, method: string, what: string) {
    // The Status object's reason is a word such as Forbidden; its message is left out, in case it ever echoes the request.
    const reason = ((await response.json().catch(() => ({}))) as { reason?: string }).reason
    return new Error(`Kubernetes answered ${response.status}${reason ? ` ${reason}` : ""} to ${method} ${what}`)
  }
  /** A merge patch of `data` into the object, or, when it does not exist, the object created with it, labelled as the ops Jobs'. */
  async function write(collection: string, kind: string, name: string, data: Record<string, string>, type?: string) {
    const patched = await call("PATCH", `${collection}/${name}?${asOps}`, { data })
    if (patched.ok) return
    if (patched.status !== 404) throw await refusal(patched, "PATCH", `${kind} ${name}`)
    const created = await call("POST", `${collection}?${asOps}`, {
      apiVersion: "v1",
      kind,
      metadata: { name, namespace, labels: { "app.kubernetes.io/managed-by": "answerable-ops" } },
      ...(type ? { type } : {}),
      data,
    })
    if (!created.ok) throw await refusal(created, "POST", `${kind} ${name}`)
  }
  return {
    async readSecret(name) {
      const response = await call("GET", `${secrets}/${name}`)
      if (response.status === 404) return undefined
      if (!response.ok) throw await refusal(response, "GET", `Secret ${name}`)
      const { data = {} } = (await response.json()) as { data?: Record<string, string> }
      return Object.fromEntries(Object.entries(data).map(([key, value]) => [key, decode(value)]))
    },
    writeSecretKey: (name, key, value) => write(secrets, "Secret", name, { [key]: encode(value) }, "Opaque"),
    async readConfigMap(name) {
      const response = await call("GET", `${configMaps}/${name}`)
      if (response.status === 404) return undefined
      if (!response.ok) throw await refusal(response, "GET", `ConfigMap ${name}`)
      return ((await response.json()) as { data?: Record<string, string> }).data ?? {}
    },
    writeConfigMap: (name, data) => write(configMaps, "ConfigMap", name, data),
    async replicas(name) {
      const response = await call("GET", `${deployments}/${name}`)
      if (response.status === 404) return undefined
      if (!response.ok) throw await refusal(response, "GET", `Deployment ${name}`)
      const { spec } = (await response.json()) as { spec: { replicas?: number } }
      return spec.replicas ?? 1
    },
    async setReplicas(name, replicas) {
      const response = await call("PATCH", `${deployments}/${name}?${asOps}`, { spec: { replicas } })
      if (!response.ok) throw await refusal(response, "PATCH", `Deployment ${name}`)
    },
  }
}

/** The client a pod has: its ServiceAccount's mounted token, certificate authority and namespace, and the API server Kubernetes names in the environment. */
export function inClusterKubernetes(env: Record<string, string | undefined>, { directory = "/var/run/secrets/kubernetes.io/serviceaccount", fetch }: { directory?: string; fetch?: typeof globalThis.fetch } = {}) {
  const read = (file: string) => readFileSync(join(directory, file), "utf8").trim()
  const host = env.KUBERNETES_SERVICE_HOST
  const server = host ? `https://${host.includes(":") ? `[${host}]` : host}:${env.KUBERNETES_SERVICE_PORT ?? "443"}` : "https://kubernetes.default.svc"
  return createKubernetes({ server, token: read("token"), ca: read("ca.crt"), namespace: read("namespace"), fetch })
}
