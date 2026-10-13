import { afterEach, describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { main, systemDeps, type CliDeps } from "./cli"
import { hostsFor } from "./environments"
import { systemRunner } from "./run"
import { createFakeRunner, createRoot, type RecordedCall } from "./testing"
import type { RunResult } from "./run"

const TAG = `sha-${"a".repeat(40)}`
const DIGEST = `sha256:${"1".repeat(64)}`
const PAIRS = ["id", "toolbox", "admin-mcp", "ops"].flatMap((name) => ["--image-digest", `${name}=${DIGEST}`])
const CERTIFICATE = "-----BEGIN CERTIFICATE-----\nMIIBdemo\n-----END CERTIFICATE-----"
const CLUSTER_ENV = {
  KUBE_SERVER: "https://cluster.example:6443",
  KUBE_CA: Buffer.from(CERTIFICATE).toString("base64"),
  KUBE_TOKEN: "deployer-token-value",
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

async function fixture(
  reply: (call: RecordedCall) => Partial<RunResult> | undefined = () => undefined,
  overrides: Partial<CliDeps> = {},
) {
  const root = await createRoot({
    "charts/answerable/values-civo-staging.yaml": "",
    "infra/civo/envs/staging/secrets.enc.yaml": "sops: {}\n",
    "infra/civo/envs/staging/database-ca.pem": "-----BEGIN CERTIFICATE-----\nMIIBdemo\n-----END CERTIFICATE-----\n",
  })
  cleanups.push(root.remove)
  // The registry answers the same digest for every image, and both client Secrets exist.
  const runner = createFakeRunner((call) =>
    call.argv[0] === "docker"
      ? { stdout: `${DIGEST}\n` }
      : call.argv.slice(0, 3).join(" ") === "kubectl get secret"
        ? { stdout: "secret/toolbox-id-client\nsecret/admin-id-client\n" }
        : reply(call),
  )
  const out: string[] = []
  const err: string[] = []
  const deps: CliDeps = {
    run: runner.run,
    fetch: async () => new Response("not found", { status: 404 }),
    sleep: async () => {},
    now: () => 0,
    env: CLUSTER_ENV,
    root: root.path,
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    ...overrides,
  }
  return { deps, runner, out: () => out.join(""), err: () => err.join("") }
}

describe("deploy", () => {
  test("deploys and reports on standard error, leaving standard output empty", async () => {
    const f = await fixture((call) => (call.argv[0] === "sops" ? { stdout: "kind: Secret\n" } : undefined))
    const code = await main(["deploy", "--environment", "staging", "--image-tag", TAG], f.deps)
    expect(code).toBe(0)
    expect(f.runner.commands().filter((command) => command.startsWith("docker buildx imagetools inspect"))).toHaveLength(4)
    expect(f.runner.commands()).toHaveLength(8)
    expect(f.err()).toContain(`Deployed ${TAG} to staging.`)
    expect(f.out()).toBe("")
  })

  test("passes the options through", async () => {
    const f = await fixture()
    const code = await main(
      [
        "deploy", "--environment", "staging", "--image-tag", TAG, ...PAIRS, "--bootstrap", "--timeout", "15m",
        "--values", "infra/civo/envs/staging/secrets.enc.yaml", "--secrets", "charts/answerable/values-civo-staging.yaml",
      ],
      f.deps,
    )
    expect(code).toBe(0)
    expect(f.runner.commands()[0]).toBe("sops --decrypt charts/answerable/values-civo-staging.yaml")
    expect(f.runner.commands()[3]).toContain("--wait-for-jobs --timeout 15m -f infra/civo/envs/staging/secrets.enc.yaml")
    expect(f.runner.commands()[3]).toEndWith("--set ops.bootstrap=true")
    expect(f.runner.commands()[3]).toContain(`--set images.admin-mcp.digest=${DIGEST}`)
    expect(f.runner.commands()).toHaveLength(4)
  })

  test("exits 1 and names the failing step", async () => {
    const f = await fixture((call) => (call.argv[0] === "sops" ? { exitCode: 128, stderr: "no key\n" } : undefined))
    const code = await main(["deploy", "--environment", "staging", "--image-tag", TAG], f.deps)
    expect(code).toBe(1)
    expect(f.err()).toContain("error: sops could not decrypt")
  })

  test("exits 2 for a missing option, a bad tag, an unknown option and a stray argument", async () => {
    for (const args of [
      ["deploy", "--image-tag", TAG],
      ["deploy", "--environment", "staging"],
      ["deploy", "--environment", "prod", "--image-tag", TAG],
      ["deploy", "--environment", "staging", "--image-tag", "latest"],
      ["deploy", "--environment", "staging", "--image-tag", TAG, "--force"],
      ["deploy", "extra", "--environment", "staging", "--image-tag", TAG],
      ["deploy", "--environment", "staging", "--image-tag", TAG, "--image-digest", `id=${DIGEST}`],
      ["deploy", "--environment", "staging", "--image-tag", TAG, "--image-digest", "id=sha256:abc"],
    ]) {
      const f = await fixture()
      expect(await main(args, f.deps)).toBe(2)
      expect(f.err()).toContain("error: ")
      expect(f.err()).toContain("Usage:")
      expect(f.runner.calls).toEqual([])
    }
  })

  test("reports the missing variable when there are no cluster credentials", async () => {
    const f = await fixture(() => undefined, { env: {} })
    expect(await main(["deploy", "--environment", "staging", "--image-tag", TAG], f.deps)).toBe(2)
    expect(f.err()).toContain("error: KUBE_SERVER is not set")
  })
})

describe("run-job", () => {
  test("runs the named job with the tag it is given", async () => {
    const f = await fixture()
    const code = await main(["run-job", "bootstrap", "--environment", "staging", "--image-tag", TAG], f.deps)
    expect(code).toBe(0)
    expect(f.runner.commands()).toHaveLength(5)
    expect(f.runner.commands()[4]).toContain("--set ops.bootstrap=true")
  })

  test("pins the digests it is given for the tag it is given", async () => {
    const f = await fixture()
    const code = await main(["run-job", "bootstrap", "--environment", "staging", "--image-tag", TAG, ...PAIRS], f.deps)
    expect(code).toBe(0)
    expect(f.runner.commands()[0]).toContain(`--set image.tag=${TAG} --set images.id.digest=${DIGEST}`)
    expect(f.runner.commands().some((command) => command.startsWith("docker "))).toBe(false)
  })

  test("refuses digests without a tag", async () => {
    const f = await fixture()
    expect(await main(["run-job", "register", "--environment", "staging", ...PAIRS], f.deps)).toBe(2)
    expect(f.err()).toContain("digests belong to a tag")
    expect(f.runner.calls).toEqual([])
  })

  test("takes the release's tag when none is given, and passes --values and --timeout", async () => {
    const f = await fixture((call) =>
      call.argv[1] === "get" && call.argv[0] === "helm" ? { stdout: JSON.stringify({ image: { tag: TAG } }) } : undefined,
    )
    const code = await main(
      ["run-job", "bootstrap", "--environment", "staging", "--values", "charts/answerable/values-civo-staging.yaml", "--timeout", "3m"],
      f.deps,
    )
    expect(code).toBe(0)
    expect(f.runner.commands()[5]).toContain(`--timeout 3m -f charts/answerable/values-civo-staging.yaml --set-file database.caPem=infra/civo/envs/staging/database-ca.pem --set image.tag=${TAG}`)
  })

  test("exits 2 without exactly one known job", async () => {
    for (const args of [
      ["run-job", "--environment", "staging"],
      ["run-job", "migrate", "--environment", "staging"],
      ["run-job", "register", "bootstrap", "--environment", "staging"],
      ["run-job", "register"],
    ]) {
      const f = await fixture()
      expect(await main(args, f.deps)).toBe(2)
      expect(f.runner.calls).toEqual([])
    }
  })
})

describe("current-tag", () => {
  test("prints only the tag on standard output", async () => {
    const f = await fixture(() => ({ stdout: JSON.stringify({ image: { tag: TAG } }) }))
    expect(await main(["current-tag"], f.deps)).toBe(0)
    expect(f.out()).toBe(`${TAG}\n`)
  })

  test("exits 1 when the release has no tag", async () => {
    const f = await fixture(() => ({ stdout: "{}" }))
    expect(await main(["current-tag"], f.deps)).toBe(1)
    expect(f.out()).toBe("")
  })

  test("takes no options", async () => {
    const f = await fixture()
    expect(await main(["current-tag", "--environment", "staging"], f.deps)).toBe(2)
  })
})

describe("smoke", () => {
  const hosts = hostsFor("staging")
  const issuer = `https://${hosts.id}`
  const healthyFetch = async (url: string) => {
    const path = new URL(url).pathname
    if (path === "/.well-known/openid-configuration") return Response.json({ issuer, jwks_uri: `${issuer}/auth/jwks` })
    if (path === "/auth/jwks") return Response.json({ keys: [{ kid: "k" }] })
    if (path.startsWith("/.well-known/oauth-protected-resource")) {
      const host = new URL(url).host
      return Response.json({ resource: `https://${host}/mcp`, authorization_servers: [issuer] })
    }
    return Response.json({ status: "ok" })
  }

  test("prints the table on standard output and exits 0 when everything passes", async () => {
    const f = await fixture(() => undefined, { fetch: healthyFetch })
    expect(await main(["smoke", "--environment", "staging"], f.deps)).toBe(0)
    expect(f.out()).toContain("PASSED: 8 of 8 checks")
    expect(f.out()).toContain("Smoke test of staging: id.answerable-staging.uk")
    expect(f.err()).toBe("")
  })

  test("exits 1 when a check fails after the wait", async () => {
    const sleeps: number[] = []
    let clock = 0
    const f = await fixture(() => undefined, {
      sleep: async (ms) => {
        sleeps.push(ms)
        clock += ms
      },
      now: () => clock,
    })
    expect(await main(["smoke", "--environment", "production", "--wait", "10", "--interval", "5"], f.deps)).toBe(1)
    expect(f.out()).toContain("FAILED: 8 of 8 checks failed")
    expect(f.out()).toContain("id.answerable.org")
    expect(sleeps).toEqual([5000, 5000])
  })

  test("uses a two-minute wait and a five-second pause by default", async () => {
    const sleeps: number[] = []
    let clock = 0
    const f = await fixture(() => undefined, {
      sleep: async (ms) => {
        sleeps.push(ms)
        clock += ms
      },
      now: () => clock,
    })
    await main(["smoke", "--environment", "staging"], f.deps)
    expect(new Set(sleeps)).toEqual(new Set([5000]))
    expect(sleeps).toHaveLength(24)
    expect(clock).toBe(120_000)
  })

  test("exits 2 for a wait or pause that is not a number", async () => {
    for (const option of ["--wait", "--interval"]) {
      const f = await fixture()
      expect(await main(["smoke", "--environment", "staging", option, "soon"], f.deps)).toBe(2)
      expect(f.err()).toContain(`${option} must be a number of seconds`)
    }
    const negative = await fixture()
    expect(await main(["smoke", "--environment", "staging", "--wait", "-3"], negative.deps)).toBe(2)
  })
})

describe("main", () => {
  test("prints the usage on standard output for --help and help", async () => {
    for (const args of [["--help"], ["help"]]) {
      const f = await fixture()
      expect(await main(args, f.deps)).toBe(0)
      expect(f.out()).toContain("Usage:")
      expect(f.err()).toBe("")
    }
  })

  test("exits 2 with the usage for no command and for an unknown one", async () => {
    const none = await fixture()
    expect(await main([], none.deps)).toBe(2)
    expect(none.err()).toContain("Usage:")
    const unknown = await fixture()
    expect(await main(["rollback"], unknown.deps)).toBe(2)
    expect(unknown.err()).toContain('unknown command "rollback"')
  })

  test("reports an unexpected failure and exits 1", async () => {
    const f = await fixture(() => {
      throw new Error("the runner broke")
    })
    expect(await main(["current-tag"], f.deps)).toBe(1)
    expect(f.err()).toContain("unexpected error: ")
    expect(f.err()).toContain("the runner broke")
  })

  test("reports an unexpected value that is not an Error", async () => {
    const f = await fixture(() => {
      throw "plain text"
    })
    expect(await main(["current-tag"], f.deps)).toBe(1)
    expect(f.err()).toContain("unexpected error: plain text")
  })
})

describe("systemDeps", () => {
  test("wires the real runner and the repository root", async () => {
    const deps = systemDeps()
    expect(deps.run).toBe(systemRunner)
    expect(deps.root).toBe(resolve(import.meta.dir, "../../.."))
    expect(JSON.parse(await readFile(resolve(deps.root, "package.json"), "utf8")).name).toBe("answerable")
    expect(deps.env).toBe(process.env)
    expect(deps.now()).toBeGreaterThan(0)
    expect(typeof deps.fetch).toBe("function")
  })
})

describe("the command line", () => {
  test("runs as a program: usage and exit codes", async () => {
    const entry = resolve(import.meta.dir, "cli.ts")
    const help = await systemRunner([process.execPath, entry, "--help"])
    expect(help.exitCode).toBe(0)
    expect(help.stdout).toContain("Usage:")
    const unknown = await systemRunner([process.execPath, entry, "nope"])
    expect(unknown.exitCode).toBe(2)
    expect(unknown.stderr).toContain('unknown command "nope"')
  })
})
