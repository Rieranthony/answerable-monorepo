import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { main, systemDeps, type CliDeps } from "./cli"
import { hostsFor } from "./environments"
import { systemRunner } from "./run"
import { createFakeRunner, createRoot, type RecordedCall } from "./testing"
import type { RunResult } from "./run"

const TAG = `sha-${"a".repeat(40)}`
const DIGEST = `sha256:${"1".repeat(64)}`
const PAIRS = ["id", "mcps", "ops"].flatMap((name) => ["--image-digest", `${name}=${DIGEST}`])
const REVISION = "c".repeat(40)
/** The chart's list as the checkout holds it: an MCP in each place. */
const MCPS = { mcps: [{ name: "e2e", serve: "both", database: "shared" }, { name: "example", serve: "toolbox", database: "shared" }] }
const CERTIFICATE = "-----BEGIN CERTIFICATE-----\nMIIBdemo\n-----END CERTIFICATE-----"
const CLUSTER_ENV = {
  KUBE_SERVER: "https://cluster.example:6443",
  KUBE_CA: Buffer.from(CERTIFICATE).toString("base64"),
  KUBE_TOKEN: "deployer-token-value",
}
const ENV = { ...CLUSTER_ENV, BETTER_AUTH_SECRET: "b", ROOT_ADMIN_SECRET: "r" }

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

async function fixture(
  reply: (call: RecordedCall) => Partial<RunResult> | undefined = () => undefined,
  overrides: Partial<CliDeps> = {},
) {
  const root = await createRoot({ "charts/answerable/values-civo-staging.yaml": "", "charts/answerable/mcps.json": JSON.stringify(MCPS) })
  cleanups.push(root.remove)
  // The registry answers the same digest for every image, every client Secret exists, the release runs REVISION and tar leaves its overlay.
  const runner = createFakeRunner((call) => {
    if (call.argv[0] === "docker") return { stdout: `${DIGEST}\n` }
    if (call.argv.slice(0, 3).join(" ") === "kubectl get secret") return { stdout: "secret/toolbox-id-client\nsecret/admin-id-client\nsecret/standalone-id-client\n" }
    if (call.argv.slice(0, 3).join(" ") === "helm get values") return { stdout: JSON.stringify({ image: { tag: `sha-${REVISION}` } }) }
    if (call.argv[0] === "tar") {
      mkdirSync(join(call.argv[4]!, "charts/answerable"), { recursive: true })
      writeFileSync(join(call.argv[4]!, "charts/answerable/values-civo-staging.yaml"), "")
    }
    return reply(call)
  })
  const out: string[] = []
  const err: string[] = []
  const deps: CliDeps = {
    run: runner.run,
    fetch: async () => new Response("not found", { status: 404 }),
    sleep: async () => {},
    now: () => 0,
    env: ENV,
    root: root.path,
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    ...overrides,
  }
  return { deps, runner, out: () => out.join(""), err: () => err.join("") }
}

describe("deploy", () => {
  test("deploys and reports on standard error, leaving standard output empty", async () => {
    const f = await fixture()
    const code = await main(["deploy", "--environment", "staging", "--image-tag", TAG], f.deps)
    expect(code).toBe(0)
    expect(f.runner.commands().filter((command) => command.startsWith("docker buildx imagetools inspect"))).toHaveLength(3)
    expect(f.runner.commands()).toHaveLength(6)
    expect(f.runner.commands().at(-1)).toContain("--set ops.bootstrap=true")
    expect(f.err()).toContain(`Deployed ${TAG} to staging.`)
    expect(f.out()).toBe("")
  })

  test("passes the digests and the timeout through", async () => {
    const f = await fixture()
    const code = await main(["deploy", "--environment", "staging", "--image-tag", TAG, ...PAIRS, "--timeout", "15m"], f.deps)
    expect(code).toBe(0)
    expect(f.runner.commands()).toHaveLength(3)
    expect(f.runner.commands()[2]).toContain("--timeout 15m -f charts/answerable/values-civo-staging.yaml")
    expect(f.runner.commands()[2]).toContain(`--set images.mcps.digest=${DIGEST}`)
  })

  test("exits 1 and names the failing step", async () => {
    const f = await fixture((call) => (call.argv[0] === "helm" ? { exitCode: 1 } : undefined))
    const code = await main(["deploy", "--environment", "staging", "--image-tag", TAG], f.deps)
    expect(code).toBe(1)
    expect(f.err()).toContain("error: helm upgrade failed with exit code 1")
  })

  test("exits 2 for a missing option, a bad tag, an option it no longer takes and a stray argument", async () => {
    for (const args of [
      ["deploy", "--image-tag", TAG],
      ["deploy", "--environment", "staging"],
      ["deploy", "--environment", "prod", "--image-tag", TAG],
      ["deploy", "--environment", "staging", "--image-tag", "latest"],
      ["deploy", "--environment", "staging", "--image-tag", TAG, "--bootstrap"],
      ["deploy", "--environment", "staging", "--image-tag", TAG, "--secrets", "x"],
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

  test("reports the missing variable when there are no cluster credentials or secrets", async () => {
    const noCluster = await fixture(() => undefined, { env: {} })
    expect(await main(["deploy", "--environment", "staging", "--image-tag", TAG], noCluster.deps)).toBe(2)
    expect(noCluster.err()).toContain("error: KUBE_SERVER is not set")
    const noSecrets = await fixture(() => undefined, { env: CLUSTER_ENV })
    expect(await main(["deploy", "--environment", "staging", "--image-tag", TAG], noSecrets.deps)).toBe(2)
    expect(noSecrets.err()).toContain("error: BETTER_AUTH_SECRET, ROOT_ADMIN_SECRET are not set")
  })
})

describe("run-job", () => {
  test("runs the named job, with the email and the timeout given, and prints the commit it ran at on standard output", async () => {
    const f = await fixture()
    const code = await main(["run-job", "make-admin", "--environment", "staging", "--email", "you@answerable.org", "--timeout", "3m"], f.deps)
    expect(code).toBe(0)
    const upgrade = f.runner.commands().find((command) => command.startsWith("helm upgrade"))!
    expect(upgrade).toContain("--timeout 3m --reset-then-reuse-values")
    expect(upgrade).toEndWith("--set ops.makeAdmin=true --set-string ops.adminEmail=you@answerable.org")
    expect(f.err()).toContain("Ran make-admin in staging.")
    expect(f.out()).toBe(`revision=${REVISION}\n`)
  })

  test("exits 2 without exactly one known job, without the environment, or with options it does not take", async () => {
    for (const args of [
      ["run-job", "--environment", "staging"],
      ["run-job", "migrate", "--environment", "staging"],
      ["run-job", "register", "bootstrap", "--environment", "staging"],
      ["run-job", "register"],
      ["run-job", "make-admin", "--environment", "staging"],
      ["run-job", "register", "--environment", "staging", "--image-tag", TAG],
    ]) {
      const f = await fixture()
      expect(await main(args, f.deps)).toBe(2)
      expect(f.runner.calls).toEqual([])
    }
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
      return Response.json({ resource: `https://${host}${path.slice("/.well-known/oauth-protected-resource".length)}`, authorization_servers: [issuer] })
    }
    return Response.json({ status: "ok", providers: ["e2e", "example"] })
  }

  test("checks the MCPs of the checkout's charts/answerable/mcps.json, prints the table on standard output and exits 0 when everything passes", async () => {
    const f = await fixture(() => undefined, { fetch: healthyFetch })
    expect(await main(["smoke", "--environment", "staging"], f.deps)).toBe(0)
    expect(f.out()).toContain("PASSED: 9 of 9 checks")
    expect(f.out()).toContain("e2e resource metadata")
    expect(f.out()).toContain('status "ok", 2 providers mounted')
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
    expect(f.out()).toContain("FAILED: 9 of 9 checks failed")
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
    expect(await main(["run-job", "bootstrap", "--environment", "staging"], f.deps)).toBe(1)
    expect(f.err()).toContain("unexpected error: ")
    expect(f.err()).toContain("the runner broke")
  })

  test("reports the message of an error whose stack lacks it", async () => {
    const f = await fixture(() => {
      const error = new Error("the runner broke")
      error.stack = "Error\n    at somewhere"
      throw error
    })
    expect(await main(["run-job", "bootstrap", "--environment", "staging"], f.deps)).toBe(1)
    expect(f.err()).toContain("unexpected error: the runner broke\nError\n    at somewhere")
  })

  test("reports an unexpected value that is not an Error", async () => {
    const f = await fixture(() => {
      throw "plain text"
    })
    expect(await main(["run-job", "bootstrap", "--environment", "staging"], f.deps)).toBe(1)
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
