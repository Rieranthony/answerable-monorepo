import { expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createKubernetes, inClusterKubernetes } from "./kubernetes"

type Call = { method: string; url: string; headers: Record<string, string>; body?: unknown; ca?: string }

/** A fetch that records each request and answers from `answers`, keyed by "<METHOD> <path>", else 404. */
function recordedFetch(answers: Record<string, { status: number; body?: unknown } | undefined>) {
  const calls: Call[] = []
  const fetch = (async (input: string | URL | Request, init?: RequestInit & { tls?: { ca?: string } }) => {
    const url = new URL(String(input))
    const method = init?.method ?? "GET"
    calls.push({ method, url: url.href, headers: init?.headers as Record<string, string>, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)), ca: init?.tls?.ca })
    const answer = answers[`${method} ${url.pathname}`] ?? { status: 404, body: { kind: "Status", reason: "NotFound" } }
    return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), { status: answer.status })
  }) as typeof globalThis.fetch
  return { fetch, calls }
}

const secretPath = "/api/v1/namespaces/answerable/secrets"
const deploymentPath = "/apis/apps/v1/namespaces/answerable/deployments"
const base64 = (value: string) => Buffer.from(value).toString("base64")

function client(answers: Parameters<typeof recordedFetch>[0]) {
  const recorded = recordedFetch(answers)
  return { ...recorded, kube: createKubernetes({ server: "https://kubernetes.default.svc", token: "sa-token", ca: "CA PEM", namespace: "answerable", fetch: recorded.fetch }) }
}

test("reads a Secret's keys decoded, with the ServiceAccount's token and the cluster's certificate authority; a missing Secret is undefined", async () => {
  const { kube, calls } = client({ [`GET ${secretPath}/id-database`]: { status: 200, body: { data: { DATABASE_URL: base64("postgres://x") } } }, [`GET ${secretPath}/empty`]: { status: 200, body: {} } })
  expect(await kube.readSecret("id-database")).toEqual({ DATABASE_URL: "postgres://x" })
  expect(await kube.readSecret("empty")).toEqual({})
  expect(await kube.readSecret("missing")).toBeUndefined()
  expect(calls[0]).toMatchObject({ method: "GET", url: `https://kubernetes.default.svc${secretPath}/id-database`, headers: { Authorization: "Bearer sa-token" }, ca: "CA PEM" })
})

test("writes one key: a merge patch on an existing Secret, else a new Opaque Secret labelled as the ops Jobs', each as the field manager answerable-ops", async () => {
  const existing = client({ [`PATCH ${secretPath}/id-database`]: { status: 200, body: {} } })
  await existing.kube.writeSecretKey("id-database", "DATABASE_URL", "postgres://y")
  expect(existing.calls).toEqual([expect.objectContaining({ method: "PATCH", url: `https://kubernetes.default.svc${secretPath}/id-database?fieldManager=answerable-ops`, headers: expect.objectContaining({ "Content-Type": "application/merge-patch+json" }), body: { data: { DATABASE_URL: base64("postgres://y") } } })])
  const missing = client({ [`POST ${secretPath}`]: { status: 201, body: {} } })
  await missing.kube.writeSecretKey("toolbox-id-client", "TOOLBOX_ID_CLIENT_SECRET", "s3cret")
  expect(missing.calls.map(call => call.method)).toEqual(["PATCH", "POST"])
  expect(missing.calls[1]!.url).toBe(`https://kubernetes.default.svc${secretPath}?fieldManager=answerable-ops`)
  expect(missing.calls[1]!.body).toEqual({
    apiVersion: "v1",
    kind: "Secret",
    metadata: { name: "toolbox-id-client", namespace: "answerable", labels: { "app.kubernetes.io/managed-by": "answerable-ops" } },
    type: "Opaque",
    data: { TOOLBOX_ID_CLIENT_SECRET: base64("s3cret") },
  })
})

test("a refusal names the Secret and the status, never a value", async () => {
  const { kube } = client({ [`GET ${secretPath}/id-database`]: { status: 403, body: { kind: "Status", reason: "Forbidden", message: "secrets is forbidden" } }, [`PATCH ${secretPath}/id-database`]: { status: 422, body: { reason: "Invalid" } } })
  await expect(kube.readSecret("id-database")).rejects.toThrow("Kubernetes answered 403 Forbidden to GET Secret id-database")
  const write = kube.writeSecretKey("id-database", "DATABASE_URL", "postgres://never-shown")
  await expect(write).rejects.toThrow("Kubernetes answered 422 Invalid to PATCH Secret id-database")
  await expect(write).rejects.not.toThrow("never-shown")
  const creating = client({ [`POST ${secretPath}`]: { status: 403 } })
  await expect(creating.kube.writeSecretKey("x", "K", "v")).rejects.toThrow("Kubernetes answered 403 to POST Secret x")
})

const configMapPath = "/api/v1/namespaces/answerable/configmaps"

test("reads a ConfigMap's data, empty when it has none, undefined when it is missing; a refusal names it", async () => {
  const { kube, calls } = client({ [`GET ${configMapPath}/postgres-ca`]: { status: 200, body: { data: { "ca.pem": "PEM" } } }, [`GET ${configMapPath}/bare`]: { status: 200, body: {} }, [`GET ${configMapPath}/forbidden`]: { status: 403, body: { reason: "Forbidden" } } })
  expect(await kube.readConfigMap("postgres-ca")).toEqual({ "ca.pem": "PEM" })
  expect(await kube.readConfigMap("bare")).toEqual({})
  expect(await kube.readConfigMap("missing")).toBeUndefined()
  expect(calls[0]).toMatchObject({ method: "GET", url: `https://kubernetes.default.svc${configMapPath}/postgres-ca`, headers: { Authorization: "Bearer sa-token" }, ca: "CA PEM" })
  await expect(kube.readConfigMap("forbidden")).rejects.toThrow("Kubernetes answered 403 Forbidden to GET ConfigMap forbidden")
})

test("writes a ConfigMap's keys: a merge patch on an existing one, else a new one labelled as the ops Jobs', as the field manager answerable-ops", async () => {
  const existing = client({ [`PATCH ${configMapPath}/postgres-ca`]: { status: 200, body: {} } })
  await existing.kube.writeConfigMap("postgres-ca", { "ca.pem": "PEM" })
  expect(existing.calls).toEqual([expect.objectContaining({ method: "PATCH", url: `https://kubernetes.default.svc${configMapPath}/postgres-ca?fieldManager=answerable-ops`, body: { data: { "ca.pem": "PEM" } } })])
  const missing = client({ [`POST ${configMapPath}`]: { status: 201, body: {} } })
  await missing.kube.writeConfigMap("postgres-ca", { "ca.pem": "PEM" })
  expect(missing.calls.map(call => call.method)).toEqual(["PATCH", "POST"])
  expect(missing.calls[1]!.body).toEqual({ apiVersion: "v1", kind: "ConfigMap", metadata: { name: "postgres-ca", namespace: "answerable", labels: { "app.kubernetes.io/managed-by": "answerable-ops" } }, data: { "ca.pem": "PEM" } })
  const refused = client({ [`POST ${configMapPath}`]: { status: 403, body: { reason: "Forbidden" } } })
  await expect(refused.kube.writeConfigMap("postgres-ca", { "ca.pem": "PEM" })).rejects.toThrow("Kubernetes answered 403 Forbidden to POST ConfigMap postgres-ca")
})

test("reads a Deployment's replicas, 1 when unset as Kubernetes defaults it, undefined when it is missing, and patches them", async () => {
  const { kube, calls } = client({
    [`GET ${deploymentPath}/toolbox`]: { status: 200, body: { spec: { replicas: 0 } } },
    [`GET ${deploymentPath}/unset`]: { status: 200, body: { spec: {} } },
    [`PATCH ${deploymentPath}/toolbox`]: { status: 200, body: {} },
  })
  expect(await kube.replicas("toolbox")).toBe(0)
  expect(await kube.replicas("unset")).toBe(1)
  expect(await kube.replicas("admin-mcp")).toBeUndefined()
  await kube.setReplicas("toolbox", 2)
  expect(calls.at(-1)).toMatchObject({ method: "PATCH", url: `https://kubernetes.default.svc${deploymentPath}/toolbox?fieldManager=answerable-ops`, body: { spec: { replicas: 2 } } })
  await expect(kube.setReplicas("admin-mcp", 1)).rejects.toThrow("Kubernetes answered 404 NotFound to PATCH Deployment admin-mcp")
  const broken = client({ [`GET ${deploymentPath}/toolbox`]: { status: 500 } })
  await expect(broken.kube.replicas("toolbox")).rejects.toThrow("Kubernetes answered 500 to GET Deployment toolbox")
})

test("a call the API server does not answer fails naming the path and the egress setting; a network error is passed on", async () => {
  const silent = (async (_input: string | URL | Request, init?: RequestInit) => new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)))) as typeof globalThis.fetch
  const kube = createKubernetes({ server: "https://10.43.0.1", token: "t", ca: "CA", namespace: "answerable", fetch: silent, timeoutMs: 20 })
  await expect(kube.readSecret("id-database")).rejects.toThrow(`The Kubernetes API did not answer GET ${secretPath}/id-database within 0.02 s: can this pod reach https://10.43.0.1 (networkPolicy.kubernetesApi)?`)
  const refused = (async () => { throw new TypeError("connection refused") }) as unknown as typeof globalThis.fetch
  await expect(createKubernetes({ server: "https://10.43.0.1", token: "t", ca: "CA", namespace: "answerable", fetch: refused }).readSecret("x")).rejects.toThrow("connection refused")
})

test("inside a pod it reads the mounted ServiceAccount's token, certificate authority and namespace, and the API server from the environment", async () => {
  const directory = mkdtempSync(join(tmpdir(), "infra-ops-sa-"))
  try {
    writeFileSync(join(directory, "token"), "mounted-token\n")
    writeFileSync(join(directory, "ca.crt"), "MOUNTED CA")
    writeFileSync(join(directory, "namespace"), "answerable")
    const recorded = recordedFetch({ [`GET ${secretPath}/id-database`]: { status: 200, body: { data: {} } } })
    const kube = inClusterKubernetes({ KUBERNETES_SERVICE_HOST: "10.96.0.1", KUBERNETES_SERVICE_PORT: "6443" }, { directory, fetch: recorded.fetch })
    await kube.readSecret("id-database")
    expect(recorded.calls[0]).toMatchObject({ url: `https://10.96.0.1:6443${secretPath}/id-database`, headers: { Authorization: "Bearer mounted-token" }, ca: "MOUNTED CA" })
    // Without the service variables the in-cluster name is used.
    const other = recordedFetch({})
    await inClusterKubernetes({}, { directory, fetch: other.fetch }).readSecret("x")
    expect(other.calls[0]!.url).toBe(`https://kubernetes.default.svc${secretPath}/x`)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
