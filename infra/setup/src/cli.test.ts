import { afterEach, describe, expect, test } from "bun:test"
import { join, resolve } from "node:path"
import { ask, main, systemDeps, type CliDeps } from "./cli"
import { systemRunner } from "./run"
import { createContext, createFakeRunner, createRoot, type RecordedCall } from "./testing"
import type { RunResult } from "./run"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

async function fixture(reply: (call: RecordedCall) => Partial<RunResult> | undefined = () => undefined, env: CliDeps["env"] = {}) {
  const root = await createRoot({ "infra/civo/envs/staging/.terraform/terraform.tfstate": "{}" })
  cleanups.push(root.remove)
  const runner = createFakeRunner(reply)
  const errors: string[] = []
  const { context, output } = createContext({ run: runner.run, env })
  const deps: CliDeps = { ...context, root: root.path, home: join(root.path, "home"), err: (text) => errors.push(text) }
  return { deps, runner, root: root.path, output, errors: () => errors.join("") }
}

describe("main", () => {
  test("prints the usage on --help", async () => {
    for (const flag of ["--help", "help", "-h"]) {
      const f = await fixture()
      expect(await main([flag], f.deps)).toBe(0)
      expect(f.output()).toContain("Usage: bun run setup <command> --environment <staging|production>")
    }
  })

  test("exits 2 with the usage for a missing or unknown command, a bad option or environment, or a missing value", async () => {
    for (const argv of [
      [],
      ["deploy", "--environment", "staging"],
      ["age-init"],
      ["age-init", "--environment", "prod"],
      ["age-init", "--environment", "staging", "--yes"],
      ["age-init", "--environment", "staging", "stray"],
      ["origin-pull", "--environment", "staging"],
      ["origin-pull", "--environment", "staging", "--zone", "answerable-staging.uk", "--wait", "soon"],
      ["id-first-run", "--environment", "staging", "--domain", "answerable.org"],
      ["id-make-admin", "--environment", "staging", "--email", " "],
    ]) {
      const f = await fixture()
      expect(await main(argv, f.deps)).toBe(2)
      expect(f.errors()).toStartWith("error: ")
      expect(f.errors()).toContain("Usage:")
      expect(f.runner.calls).toEqual([])
    }
  })

  test("exits 1 with the message for a failed step, and with the stack for anything unexpected", async () => {
    const failed = await fixture()
    expect(await main(["database-ca", "--environment", "staging", "--from-stdin"], failed.deps)).toBe(1)
    expect(failed.errors()).toBe("error: standard input holds no PEM certificate: pipe in the output of openssl s_client -showcerts\n")
    const broken = await fixture()
    broken.deps.readStdin = async () => {
      throw new Error("stdin went away")
    }
    expect(await main(["database-ca", "--environment", "staging", "--from-stdin"], broken.deps)).toBe(1)
    expect(broken.errors()).toStartWith("unexpected error: Error: stdin went away")
    const odd = await fixture()
    odd.deps.readStdin = async () => {
      throw "a string"
    }
    expect(await main(["database-ca", "--environment", "staging", "--from-stdin"], odd.deps)).toBe(1)
    expect(odd.errors()).toBe("unexpected error: a string\n")
  })

  test("hands each command its options, with --sops-config and --key-dir moving those files", async () => {
    const f = await fixture((call) => (call.argv[1] === "-y" ? { stdout: `age1${"q".repeat(58)}\n` } : undefined))
    await Bun.write(join(f.root, "k/answerable-staging.txt"), "AGE-SECRET-KEY-1X\n")
    const code = await main(
      ["age-init", "--environment", "staging", "--sops-config", join(f.root, "s.yaml"), "--key-dir", join(f.root, "k")],
      f.deps,
    )
    expect(code).toBe(0)
    expect(f.runner.commands()[0]).toBe(`age-keygen -y ${join(f.root, "k/answerable-staging.txt")}`)
    expect(await Bun.file(join(f.root, "s.yaml")).text()).toContain("creation_rules:")

    const dispatched: Array<[string[], string]> = [
      [["first-apply", "--environment", "staging", "--yes"], "CIVO_TOKEN is not set"],
      [["origin-pull", "--environment", "staging", "--zone", "answerable-staging.uk", "--wait", "5"], "CLOUDFLARE_API_TOKEN is not set"],
      [["database-ca", "--environment", "staging", "--force"], "these commands need OpenSSL 3"],
      [["init-secrets", "--environment", "staging", "--rotate", "BETTER_AUTH_SECRET"], "Rotate it through BETTER_AUTH_SECRETS"],
      [["publish-env", "--environment", "production", "--enable"], "--enable switches on staging's deploys"],
      [["id-first-run", "--environment", "staging", "--domain", "answerable.org", "--entra-tenant", "x"], "--entra-tenant must be"],
      [["id-make-admin", "--environment", "staging", "--email", "nobody"], "--email must be an email address"],
    ]
    for (const [argv, message] of dispatched) {
      const each = await fixture()
      await main(argv, each.deps)
      expect(each.errors()).toContain(message)
    }
  })
})

describe("ask", () => {
  test("prints the question and answers the first line, or null when input has ended", async () => {
    const printed: string[] = []
    async function* lines(...items: string[]) {
      yield* items
    }
    expect(await ask(lines("yes", "more"), (text) => printed.push(text), "Go? ")).toBe("yes")
    expect(await ask(lines(), (text) => printed.push(text), "Again? ")).toBeNull()
    expect(printed).toEqual(["Go? ", "Again? "])
  })
})

test("systemDeps wires the real world in", () => {
  const deps = systemDeps()
  expect(deps.run).toBe(systemRunner)
  expect(deps.root).toBe(resolve(import.meta.dir, "../../.."))
  expect(deps.env).toBe(process.env)
  expect(typeof deps.ask).toBe("function")
  expect(typeof deps.readStdin).toBe("function")
  expect(deps.home.length).toBeGreaterThan(0)
})
