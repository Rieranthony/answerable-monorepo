import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, readFileSync, statSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { databaseCa, FETCH_IMAGE, podCommand } from "./database-ca"
import { pathsFor } from "./environments"
import { INTERMEDIATE, LEAF, ROOT } from "./test-certificates"
import { createContext, createFakeRunner, createRoot, type RecordedCall } from "./testing"
import type { RunResult } from "./run"

const STATE = { AWS_ACCESS_KEY_ID: "key-id", AWS_SECRET_ACCESS_KEY: "state-secret" }
const S_CLIENT = (chain: string[]) =>
  `CONNECTED(00000003)\n---\nCertificate chain\n${chain.map((pem, at) => ` ${at} s:CN=x\n${pem}`).join("")}---\nServer certificate\n`

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

async function fixture(
  files: Record<string, string> = {},
  host = "10.10.0.5",
  reply: (call: RecordedCall) => Partial<RunResult> | undefined = () => undefined,
) {
  const root = await createRoot({ "infra/civo/envs/staging/.terraform/terraform.tfstate": "{}", ...files })
  cleanups.push(root.remove)
  const paths = pathsFor("staging", { root: root.path, home: root.path })
  const runner = createFakeRunner((call) => {
    const answer = reply(call)
    if (answer) return answer
    const line = call.argv.join(" ")
    if (line === "openssl version") return { stdout: "OpenSSL 3.6.2\n" }
    if (line === "terraform output -raw database_host") return { stdout: host }
    if (line === "terraform output -raw database_port") return { stdout: "5432" }
    if (call.argv[1] === "s_client") return { stdout: S_CLIENT([LEAF, INTERMEDIATE, ROOT]) }
    return undefined
  })
  return { paths, runner }
}

describe("database-ca", () => {
  test("connects from this machine, keeps the self-signed root and prints what to record", async () => {
    const { paths, runner } = await fixture()
    const { context, output } = createContext({ run: runner.run, env: STATE })
    await databaseCa({ environment: "staging", paths }, context)
    expect(await readFile(paths.databaseCa, "utf8")).toBe(ROOT)
    expect(runner.commands()).toEqual([
      "openssl version",
      "terraform output -raw database_host",
      "terraform output -raw database_port",
      "openssl s_client -starttls postgres -connect 10.10.0.5:5432 -showcerts",
    ])
    expect(runner.calls[3]!.options).toEqual({ timeoutMs: 15_000 })
    expect(output()).toContain("The database presented 3 certificates:\n  1. CN=db.example, issued by CN=Test Intermediate CA")
    expect(output()).toContain("Wrote infra/civo/envs/staging/database-ca.pem: the self-signed root.")
    expect(output()).toContain("Subject:     CN=Test Root CA")
    expect(output()).toMatch(/SHA-256: +([0-9A-F]{2}:){31}[0-9A-F]{2}/)
    expect(output()).toContain("Valid:       2026-10-13T13:32:54.000Z to 2126-09-19T13:32:54.000Z")
    expect(output()).toContain("The server's certificate names: DNS:db.example, IP Address:10.10.0.5.")
    expect(output()).toContain("It covers 10.10.0.5, the host in database_admin_url.")
    expect(output()).toContain("This is trust on first use")
    expect(output()).not.toContain("Warning")
  })

  test("warns when the certificate does not name the host", async () => {
    const { paths, runner } = await fixture({}, "10.10.0.9")
    const { context, output } = createContext({ run: runner.run, env: STATE })
    await databaseCa({ environment: "staging", paths }, context)
    expect(output()).toContain("Warning: it does not cover 10.10.0.9")
    const named = await fixture({}, "db.example")
    const second = createContext({ run: named.runner.run, env: STATE })
    await databaseCa({ environment: "staging", paths: named.paths }, second.context)
    expect(second.output()).toContain("It covers db.example")
  })

  test("fetches the chain from a pod through admin_kubeconfig when the database does not answer here", async () => {
    const seen: { kubeconfig?: string; mode?: number; file?: string } = {}
    const { paths, runner } = await fixture({}, "10.10.0.5", (call) => {
      if (call.argv[1] === "s_client") return { exitCode: 1, stderr: "connect:errno=60\nconnect: Operation timed out\n" }
      if (call.argv.join(" ") === "terraform output -raw admin_kubeconfig") return { stdout: "apiVersion: v1\nkind: Config\n" }
      if (call.argv[0] === "kubectl") {
        seen.file = call.options.env!.KUBECONFIG!
        seen.kubeconfig = readFileSync(seen.file, "utf8")
        seen.mode = statSync(seen.file).mode & 0o777
        return { stdout: S_CLIENT([LEAF, INTERMEDIATE, ROOT]) }
      }
      return undefined
    })
    const { context, output } = createContext({ run: runner.run, env: STATE })
    await databaseCa({ environment: "staging", paths, timeoutMs: 10, podTimeoutMs: 20 }, context)
    expect(await readFile(paths.databaseCa, "utf8")).toBe(ROOT)
    expect(runner.calls[3]!.options.timeoutMs).toBe(10)
    expect(seen.kubeconfig).toBe("apiVersion: v1\nkind: Config\n")
    expect(seen.mode).toBe(0o600)
    expect(existsSync(seen.file!)).toBe(false)
    const pod = runner.calls.find((call) => call.argv[0] === "kubectl")!
    expect(pod.options.timeoutMs).toBe(20)
    expect(pod.options.input).toBeUndefined()
    expect(pod.argv.slice(0, 3)).toEqual(["kubectl", "run", pod.argv[2]!])
    expect(pod.argv[2]).toMatch(/^database-ca-[0-9a-f]{6}$/)
    expect(pod.argv.slice(3)).toEqual([
      "--namespace",
      "default",
      "--rm",
      "--attach",
      "--restart=Never",
      "--quiet",
      `--image=${FETCH_IMAGE}`,
      "--command",
      "--",
      "sh",
      "-c",
      "apk add --no-cache --quiet openssl >/dev/null && openssl s_client -starttls postgres -connect 10.10.0.5:5432 -showcerts </dev/null",
    ])
    expect(output()).toContain("did not present a certificate to this machine (exit 1: connect: Operation timed out)")
    expect(output()).toContain("fetching its chain from a pod in the cluster instead")
    expect(output()).toContain("(KUBECONFIG: Terraform's admin_kubeconfig, in a 0600 temporary file)")
    expect(output()).not.toContain("kind: Config")
    expect(output()).toContain("It covers 10.10.0.5")
  })

  test("prints the pod command to run by hand when the pod fails too, and still deletes the kubeconfig", async () => {
    let file = ""
    const { paths, runner } = await fixture({}, "10.10.0.5", (call) => {
      if (call.argv[1] === "s_client") return { exitCode: 143 }
      if (call.argv.join(" ") === "terraform output -raw admin_kubeconfig") return { stdout: "apiVersion: v1\n" }
      if (call.argv[0] === "kubectl") {
        file = call.options.env!.KUBECONFIG!
        return { exitCode: 1, stderr: "error: timed out waiting for the condition\n" }
      }
      return undefined
    })
    const { context, output } = createContext({ run: runner.run, env: STATE })
    await expect(databaseCa({ environment: "staging", paths }, context)).rejects.toThrow(
      "no certificate from 10.10.0.5:5432, from this machine or from a pod",
    )
    expect(existsSync(file)).toBe(false)
    expect(runner.calls.find((call) => call.argv[0] === "kubectl")!.options.timeoutMs).toBe(180_000)
    expect(output()).toContain("(exit 143).")
    expect(output()).toContain("The pod did not fetch a certificate either (exit 1: error: timed out waiting for the condition)")
    expect(output()).toContain("(umask 077 && cd infra/civo/envs/staging && terraform output -raw admin_kubeconfig) > admin.kubeconfig")
    expect(output()).toContain(podCommand("staging", "10.10.0.5", "5432"))

    const missing = await fixture({}, "10.10.0.5", (call) => {
      if (call.argv[1] === "s_client") return { exitCode: 1 }
      if (call.argv[1] === "output" && call.argv[3] === "admin_kubeconfig") return { stdout: "x" }
      if (call.argv[0] === "kubectl") return { exitCode: 127 }
      return undefined
    })
    const second = createContext({ run: missing.runner.run, env: STATE })
    await expect(databaseCa({ environment: "staging", paths: missing.paths }, second.context)).rejects.toThrow(
      "from this machine or from a pod",
    )
    expect(second.output()).toContain("The pod did not fetch a certificate either (exit 127).")
  })

  test("reads a chain from standard input and keeps the topmost certificate when no root is presented", async () => {
    const { paths, runner } = await fixture()
    const { context, output } = createContext({ run: runner.run, readStdin: async () => S_CLIENT([LEAF, INTERMEDIATE]) })
    await databaseCa({ environment: "staging", paths, fromStdin: true }, context)
    expect(runner.calls).toEqual([])
    expect(await readFile(paths.databaseCa, "utf8")).toBe(INTERMEDIATE)
    expect(output()).toContain("the topmost certificate, since no self-signed root was presented")
    expect(output()).toContain("Warning: it is not a root.")
    expect(output()).toContain("Check that these names cover the host")
  })

  test("warns when the only certificate is not a CA", async () => {
    const { paths } = await fixture()
    const { context, output } = createContext({ readStdin: async () => LEAF })
    await databaseCa({ environment: "staging", paths, fromStdin: true }, context)
    expect(output()).toContain("The database presented 1 certificate:")
    expect(output()).toContain("Warning: it is not a CA certificate.")
  })

  test("refuses to replace the file unless forced, and refuses input without a certificate", async () => {
    const { paths } = await fixture({ "infra/civo/envs/staging/database-ca.pem": INTERMEDIATE })
    await expect(
      databaseCa({ environment: "staging", paths, fromStdin: true }, createContext({ readStdin: async () => ROOT }).context),
    ).rejects.toThrow("database-ca.pem exists. Run again with --force")
    await databaseCa(
      { environment: "staging", paths, fromStdin: true, force: true },
      createContext({ readStdin: async () => ROOT }).context,
    )
    expect(await readFile(paths.databaseCa, "utf8")).toBe(ROOT)
    await expect(
      databaseCa(
        { environment: "staging", paths, fromStdin: true, force: true },
        createContext({ readStdin: async () => "nothing" }).context,
      ),
    ).rejects.toThrow("standard input holds no PEM certificate")
    const garbage = "-----BEGIN CERTIFICATE-----\nbm90IGEgY2VydGlmaWNhdGU=\n-----END CERTIFICATE-----\n"
    await expect(
      databaseCa(
        { environment: "staging", paths, fromStdin: true, force: true },
        createContext({ readStdin: async () => garbage }).context,
      ),
    ).rejects.toThrow("a presented certificate cannot be read")
  })

  test("needs the state credential to read the database's address", async () => {
    const { paths, runner } = await fixture()
    await expect(databaseCa({ environment: "staging", paths }, createContext({ run: runner.run }).context)).rejects.toThrow(
      "AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY",
    )
  })

  test("the pod command pins its image and pipes into --from-stdin", () => {
    const command = podCommand("production", "10.20.0.5", "5432")
    expect(command).toContain(`--image=${FETCH_IMAGE} --command --`)
    expect(command).toContain("openssl s_client -starttls postgres -connect 10.20.0.5:5432 -showcerts </dev/null")
    expect(command).toEndWith("| bun run setup database-ca --environment production --from-stdin")
  })
})
