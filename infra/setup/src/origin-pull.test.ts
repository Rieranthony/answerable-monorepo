import { afterEach, describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { exists } from "./context"
import { pathsFor } from "./environments"
import { originPull } from "./origin-pull"
import { INTERMEDIATE, LEAF, ROOT } from "./test-certificates"
import { createContext, createFakeFetch, createFakeRunner, createRoot, json, type RecordedCall, type RecordedRequest } from "./testing"
import type { RunResult } from "./run"

const KEY = "-----BEGIN PRIVATE KEY-----\nclient-key-material\n-----END PRIVATE KEY-----\n"
const ENV = { CLOUDFLARE_API_TOKEN: "cf-token" }
const BASE = "https://api.cloudflare.com/client/v4/zones/zone123/origin_tls_client_auth"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

// openssl as origin-pull sees it: each step writes the file it names, with the test certificates standing in.
function fakeOpenssl(override: (call: RecordedCall) => Partial<RunResult> | undefined = () => undefined) {
  return createFakeRunner(async (call) => {
    const answer = override(call)
    if (answer) return answer
    const [, step] = call.argv
    const out = call.argv[call.argv.indexOf("-out") + 1]!
    const write = (text: string) => Bun.write(join(call.options.cwd!, out), text)
    if (step === "version") return { stdout: "OpenSSL 3.6.2 7 Apr 2026 (Library: OpenSSL 3.6.2 7 Apr 2026)\n" }
    if (step === "genpkey") await write(KEY)
    if (step === "req") await write(call.argv.includes("-x509") ? ROOT : "csr")
    if (step === "x509") await write(LEAF)
    if (step === "verify") return { stdout: "client.pem: OK\n" }
    return undefined
  })
}

function fakeCloudflare(
  options: { older?: unknown[]; statuses?: string[]; upload?: Response; zones?: unknown[]; onUpload?: () => Promise<void> } = {},
) {
  const statuses = [...(options.statuses ?? ["active"])]
  return createFakeFetch(async (request: RecordedRequest) => {
    if (request.url.endsWith("/zones?name=answerable-staging.uk"))
      return json({ success: true, result: options.zones ?? [{ id: "zone123", name: "answerable-staging.uk" }] })
    if (request.method === "GET" && request.url === BASE) return json({ success: true, result: options.older ?? [] })
    if (request.method === "POST") {
      await options.onUpload?.()
      return options.upload ?? json({ success: true, result: { id: "cert-new", status: statuses.shift() } })
    }
    if (request.url === `${BASE}/cert-new`) return json({ success: true, result: { id: "cert-new", status: statuses.shift() } })
    return json({ success: false, errors: [{ code: 7003, message: "No route" }] }, 404)
  })
}

async function fixture(files: Record<string, string> = {}) {
  const root = await createRoot(files)
  cleanups.push(root.remove)
  return pathsFor("staging", { root: root.path, home: root.path })
}

describe("origin-pull", () => {
  test("makes the CA and client certificate, uploads the client pair, waits for it and writes only the CA", async () => {
    const paths = await fixture()
    const runner = fakeOpenssl()
    const cloudflare = fakeCloudflare({ statuses: ["pending_deployment", "pending_deployment", "active"] })
    const { context, output } = createContext({ run: runner.run, fetch: cloudflare.fetch, env: ENV })
    await originPull({ environment: "staging", paths, zone: "answerable-staging.uk" }, context)

    expect(await readFile(paths.edgeCa, "utf8")).toBe(ROOT)
    const upload = cloudflare.requests.find((request) => request.method === "POST")!
    expect(upload.url).toBe(BASE)
    expect(upload.body).toEqual({ certificate: LEAF, private_key: KEY })
    expect(upload.headers.authorization).toBe("Bearer cf-token")
    expect(cloudflare.requests.filter((request) => request.url === `${BASE}/cert-new`)).toHaveLength(2)

    const commands = runner.commands()
    expect(commands[0]).toBe("openssl version")
    expect(commands[1]).toBe("openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out ca.key")
    expect(commands[2]).toContain("req -x509 -new -key ca.key -sha256 -days 3650 -subj /CN=Answerable origin-pull CA (answerable-staging.uk)")
    expect(commands[2]).toContain("-addext basicConstraints=critical,CA:TRUE,pathlen:0")
    expect(commands[4]).toContain("-subj /CN=cloudflare-origin-pull.answerable-staging.uk")
    expect(commands[5]).toMatch(/^openssl x509 -req -in client.csr -CA ca.pem -CAkey ca.key -set_serial 0x[0-7][0-9a-f]{31} -days 1825 -sha256/)
    expect(commands[6]).toBe("openssl verify -CAfile ca.pem client.pem")

    const directory = runner.calls[1]!.options.cwd!
    expect(await exists(directory)).toBe(false)
    expect(output()).toContain("Uploaded certificate cert-new to answerable-staging.uk")
    expect(output()).toContain("Subject:     CN=Test Root CA")
    expect(output()).toContain("The full apply (first-apply --resume) gives it to Traefik")
    expect(output()).not.toContain("PRIVATE KEY")
    expect(output()).not.toContain("Delete the older ones")
  })

  test("rotates: trusts both CAs while the operator applies, uploads, then keeps only the new CA", async () => {
    const paths = await fixture({ "infra/civo/envs/staging/edge-ca/ca.pem": INTERMEDIATE })
    let atUpload = ""
    const cloudflare = fakeCloudflare({
      older: [{ id: "cert-old", status: "active", expires_on: "2031-01-01T00:00:00Z" }],
      onUpload: async () => {
        atUpload = await readFile(paths.edgeCa, "utf8")
      },
    })
    const questions: string[] = []
    const { context, output } = createContext({
      run: fakeOpenssl().run,
      fetch: cloudflare.fetch,
      env: ENV,
      ask: async (question) => {
        questions.push(question)
        return ""
      },
    })
    await originPull({ environment: "staging", paths, zone: "answerable-staging.uk", force: true }, context)
    expect(atUpload).toBe(`${ROOT}${INTERMEDIATE}`)
    expect(questions).toEqual(["Press Enter once the apply has finished (or type no to stop): "])
    expect(await readFile(paths.edgeCa, "utf8")).toBe(ROOT)
    expect(output()).toContain("now holds the new CA and the old one")
    expect(output()).toContain(`curl -X DELETE -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" ${BASE}/cert-old   # active, expires 2031-01-01T00:00:00Z`)
    expect(output()).toContain("so that Traefik stops trusting the old CA")
  })

  test("puts the old CA file back when the operator stops before the upload", async () => {
    for (const answer of [null, "no", " n "]) {
      const paths = await fixture({ "infra/civo/envs/staging/edge-ca/ca.pem": INTERMEDIATE })
      const cloudflare = fakeCloudflare()
      const { context } = createContext({ run: fakeOpenssl().run, fetch: cloudflare.fetch, env: ENV, ask: async () => answer })
      await expect(originPull({ environment: "staging", paths, zone: "answerable-staging.uk", force: true }, context)).rejects.toThrow(
        "Stopped before the upload",
      )
      expect(await readFile(paths.edgeCa, "utf8")).toBe(INTERMEDIATE)
      expect(cloudflare.requests.some((request) => request.method === "POST")).toBe(false)
    }
  })

  test("a CA file without a certificate is replaced without a pause", async () => {
    const paths = await fixture({ "infra/civo/envs/staging/edge-ca/ca.pem": "\n" })
    const { context } = createContext({ run: fakeOpenssl().run, fetch: fakeCloudflare().fetch, env: ENV })
    await originPull({ environment: "staging", paths, zone: "answerable-staging.uk", force: true }, context)
    expect(await readFile(paths.edgeCa, "utf8")).toBe(ROOT)
  })

  test("refuses the wrong zone, a missing token, an existing CA file and LibreSSL", async () => {
    const paths = await fixture({ "infra/civo/envs/staging/edge-ca/ca.pem": ROOT })
    const run = fakeOpenssl().run
    await expect(originPull({ environment: "staging", paths, zone: "answerable.org" }, createContext({ run, env: ENV }).context)).rejects.toThrow(
      "--zone for staging is answerable-staging.uk, not answerable.org",
    )
    await expect(originPull({ environment: "staging", paths, zone: "answerable-staging.uk" }, createContext({ run }).context)).rejects.toThrow(
      "CLOUDFLARE_API_TOKEN is not set",
    )
    await expect(originPull({ environment: "staging", paths, zone: "answerable-staging.uk" }, createContext({ run, env: ENV }).context)).rejects.toThrow(
      "edge-ca/ca.pem exists. Run again with --force",
    )
    const libre = fakeOpenssl(() => ({ stdout: "LibreSSL 3.3.6\n" }))
    await expect(
      originPull({ environment: "staging", paths, zone: "answerable-staging.uk", force: true }, createContext({ run: libre.run, env: ENV }).context),
    ).rejects.toThrow('`openssl version` answered "LibreSSL 3.3.6"')
    const missing = fakeOpenssl(() => ({ exitCode: 127, stderr: "openssl: not found" }))
    await expect(
      originPull({ environment: "staging", paths, zone: "answerable-staging.uk", force: true }, createContext({ run: missing.run, env: ENV }).context),
    ).rejects.toThrow('answered "openssl: not found"')
  })

  test("reports Cloudflare's errors, and leaves no CA file when the first upload fails", async () => {
    const paths = await fixture()
    const refused = fakeCloudflare({ upload: json({ success: false, errors: [{ code: 1406, message: "Invalid certificate" }, {}] }, 400) })
    const { context } = createContext({ run: fakeOpenssl().run, fetch: refused.fetch, env: ENV })
    await expect(originPull({ environment: "staging", paths, zone: "answerable-staging.uk" }, context)).rejects.toThrow(
      "Cloudflare answered 400 to POST /zones/zone123/origin_tls_client_auth: 1406 Invalid certificate; ?",
    )
    expect(await exists(paths.edgeCa)).toBe(false)

    const broken = createFakeFetch(() => new Response("<html>bad gateway</html>", { status: 502 }))
    await expect(
      originPull({ environment: "staging", paths, zone: "answerable-staging.uk" }, createContext({ run: fakeOpenssl().run, fetch: broken.fetch, env: ENV }).context),
    ).rejects.toThrow("Cloudflare answered 502 to GET /zones?name=answerable-staging.uk")

    const invisible = fakeCloudflare({ zones: [] })
    await expect(
      originPull({ environment: "staging", paths, zone: "answerable-staging.uk" }, createContext({ run: fakeOpenssl().run, fetch: invisible.fetch, env: ENV }).context),
    ).rejects.toThrow("CLOUDFLARE_API_TOKEN cannot see the zone answerable-staging.uk")
  })

  test("restores the old CA file when the rotation's upload fails", async () => {
    const paths = await fixture({ "infra/civo/envs/staging/edge-ca/ca.pem": INTERMEDIATE })
    const refused = fakeCloudflare({ upload: json({ success: false }, 403) })
    const { context } = createContext({ run: fakeOpenssl().run, fetch: refused.fetch, env: ENV, ask: async () => "" })
    await expect(originPull({ environment: "staging", paths, zone: "answerable-staging.uk", force: true }, context)).rejects.toThrow(
      "Cloudflare answered 403",
    )
    expect(await readFile(paths.edgeCa, "utf8")).toBe(INTERMEDIATE)
  })

  test("fails on a certificate Cloudflare gives up on, and keeps the new CA when it is still deploying", async () => {
    const paths = await fixture()
    const failed = fakeCloudflare({ statuses: ["pending_deployment", "deployment_timed_out"] })
    await expect(
      originPull({ environment: "staging", paths, zone: "answerable-staging.uk" }, createContext({ run: fakeOpenssl().run, fetch: failed.fetch, env: ENV }).context),
    ).rejects.toThrow("Cloudflare reports the certificate deployment_timed_out")

    const slow = fakeCloudflare({ statuses: Array(10).fill("pending_deployment") })
    const { context, output } = createContext({ run: fakeOpenssl().run, fetch: slow.fetch, env: ENV })
    await expect(originPull({ environment: "staging", paths, zone: "answerable-staging.uk", waitSeconds: 10 }, context)).rejects.toThrow(
      `certificate cert-new is not active after 10 s. infra/civo/envs/staging/edge-ca/ca.pem trusts it already. Check it with: curl -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" ${BASE}/cert-new`,
    )
    expect(await readFile(paths.edgeCa, "utf8")).toBe(ROOT)
    expect(output()).toContain("Certificate status: pending_deployment")

    const silent = createFakeFetch(async (request) =>
      request.method === "POST" ? json({ success: true, result: { id: "cert-new" } }) : fakeCloudflare({ statuses: ["active"] }).fetch(request.url, { method: request.method }),
    )
    const quiet = createContext({ run: fakeOpenssl().run, fetch: silent.fetch, env: ENV })
    await originPull({ environment: "staging", paths: await fixture(), zone: "answerable-staging.uk" }, quiet.context)
    expect(quiet.output()).toContain("Certificate status: unknown")
  })

  test("stops when an openssl step fails, and deletes the temporary directory", async () => {
    const paths = await fixture()
    const failing = fakeOpenssl((call) => (call.argv[1] === "genpkey" ? { exitCode: 1, stderr: "bad curve" } : undefined))
    await expect(
      originPull({ environment: "staging", paths, zone: "answerable-staging.uk" }, createContext({ run: failing.run, fetch: fakeCloudflare().fetch, env: ENV }).context),
    ).rejects.toThrow("openssl could not make the CA's key (exit 1): bad curve")
    expect(await exists(failing.calls[1]!.options.cwd!)).toBe(false)

    const unverified = fakeOpenssl((call) => (call.argv[1] === "verify" ? { stdout: "client.pem: verification failed\n" } : undefined))
    await expect(
      originPull({ environment: "staging", paths, zone: "answerable-staging.uk" }, createContext({ run: unverified.run, fetch: fakeCloudflare().fetch, env: ENV }).context),
    ).rejects.toThrow("openssl verify did not accept the client's certificate")
  })
})
