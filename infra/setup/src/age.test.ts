import { afterEach, describe, expect, test } from "bun:test"
import { readFile, stat, chmod } from "node:fs/promises"
import { join } from "node:path"
import { ageInit, ENCRYPTED_REGEX, formatConfig, ruleRegex } from "./age"
import { pathsFor } from "./environments"
import { createContext, createFakeRunner, createRoot, type RecordedCall } from "./testing"
import { writeFile } from "node:fs/promises"

const RECIPIENT = `age1${"q".repeat(58)}`
const OTHER = `age1${"p".repeat(58)}`
const PRIVATE = `AGE-SECRET-KEY-1${"Q".repeat(58)}`

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

// age-keygen as far as age-init sees it: -o writes a key file, -y answers the recipient.
function keygen(recipient = RECIPIENT) {
  return createFakeRunner(async (call: RecordedCall) => {
    if (call.argv[1] === "-o") {
      await writeFile(call.argv[2]!, `# created: now\n# public key: ${recipient}\n${PRIVATE}\n`, { mode: 0o644 })
      return { stderr: `Public key: ${recipient}\n` }
    }
    if (call.argv[1] === "-y") return { stdout: `${recipient}\n` }
    return undefined
  })
}

async function fixture(files: Record<string, string> = {}) {
  const root = await createRoot(files)
  cleanups.push(root.remove)
  const paths = pathsFor("staging", { root: root.path, home: join(root.path, "home") })
  return { root: root.path, paths }
}

describe("age-init", () => {
  test("creates the key with mode 600 and the rule, and prints the recipient but never the private key", async () => {
    const { paths } = await fixture()
    const runner = keygen()
    const { context, output } = createContext({ run: runner.run })
    await ageInit({ environment: "staging", paths }, context)
    expect(runner.commands()).toEqual([`age-keygen -o ${paths.keyFile}`, `age-keygen -y ${paths.keyFile}`])
    expect(paths.keyFile).toEndWith("home/.config/sops/age/answerable-staging.txt")
    expect((await stat(paths.keyFile)).mode & 0o777).toBe(0o600)
    expect(Bun.YAML.parse(await readFile(paths.sopsConfig, "utf8"))).toEqual({
      creation_rules: [
        { path_regex: "infra/civo/envs/staging/secrets\\.enc\\.yaml$", age: RECIPIENT, encrypted_regex: "^(data|stringData)$" },
      ],
    })
    expect(await readFile(paths.sopsConfig, "utf8")).toContain('    encrypted_regex: "^(data|stringData)$"\n')
    expect(output()).toContain(`Recipient (public, committed in .sops.yaml): ${RECIPIENT}`)
    expect(output()).toContain(`Private key: ${paths.keyFile}`)
    expect(output()).toContain("Added the staging rule")
    expect(output()).not.toContain("AGE-SECRET-KEY")
  })

  test("keeps the other environment's rule and the existing key, and changes nothing the second time", async () => {
    const production = `creation_rules:\n  - path_regex: ${ruleRegex("production")}\n    age: ${OTHER}\n    encrypted_regex: ${ENCRYPTED_REGEX}\n`
    const { paths } = await fixture({ ".sops.yaml": production })
    const first = keygen()
    await ageInit({ environment: "staging", paths }, createContext({ run: first.run }).context)
    const written = await readFile(paths.sopsConfig, "utf8")
    expect(Bun.YAML.parse(written)).toEqual({
      creation_rules: [
        { path_regex: ruleRegex("production"), age: OTHER, encrypted_regex: ENCRYPTED_REGEX },
        { path_regex: ruleRegex("staging"), age: RECIPIENT, encrypted_regex: ENCRYPTED_REGEX },
      ],
    })
    const second = keygen()
    const { context, output } = createContext({ run: second.run })
    await ageInit({ environment: "staging", paths }, context)
    expect(second.commands()).toEqual([`age-keygen -y ${paths.keyFile}`])
    expect(output()).toContain("Using the existing key")
    expect(output()).toContain("unchanged")
    expect(await readFile(paths.sopsConfig, "utf8")).toBe(written)
  })

  test("warns when the existing key can be read by others", async () => {
    const { paths } = await fixture()
    await ageInit({ environment: "staging", paths }, createContext({ run: keygen().run }).context)
    await chmod(paths.keyFile, 0o644)
    const { context, output } = createContext({ run: keygen().run })
    await ageInit({ environment: "staging", paths }, context)
    expect(output()).toContain("can be read by other users of this machine (mode 644)")
  })

  test("refuses to point the rule at another key unless forced", async () => {
    const { paths } = await fixture({ ".sops.yaml": `creation_rules:\n  - path_regex: ${ruleRegex("staging")}\n    age: ${OTHER}\n` })
    await expect(ageInit({ environment: "staging", paths }, createContext({ run: keygen().run }).context)).rejects.toThrow(
      "encrypts staging to another recipient",
    )
    const { context, output } = createContext({ run: keygen().run })
    await ageInit({ environment: "staging", paths, force: true }, context)
    expect(output()).toContain(
      "Updated the staging rule in .sops.yaml: switched it to this key and set encrypted_regex to ^(data|stringData)$.",
    )
    expect(Bun.YAML.parse(await readFile(paths.sopsConfig, "utf8"))).toEqual({
      creation_rules: [{ path_regex: ruleRegex("staging"), age: RECIPIENT, encrypted_regex: ENCRYPTED_REGEX }],
    })
  })

  test("adds encrypted_regex to an existing rule that lacks it, and says the Secrets file changes at its next encryption", async () => {
    const { paths } = await fixture({
      ".sops.yaml": `creation_rules:\n  - path_regex: ${ruleRegex("staging")}\n    age: ${RECIPIENT}\n`,
      "infra/civo/envs/staging/secrets.enc.yaml": "sops: {}\n",
    })
    const { context, output } = createContext({ run: keygen().run })
    await ageInit({ environment: "staging", paths }, context)
    expect(Bun.YAML.parse(await readFile(paths.sopsConfig, "utf8"))).toEqual({
      creation_rules: [{ path_regex: ruleRegex("staging"), age: RECIPIENT, encrypted_regex: ENCRYPTED_REGEX }],
    })
    expect(output()).toContain("Updated the staging rule in .sops.yaml: set encrypted_regex to ^(data|stringData)$.")
    expect(output()).toContain("infra/civo/envs/staging/secrets.enc.yaml keeps the form it was encrypted in until it is encrypted again")

    const other = await fixture({
      ".sops.yaml": `creation_rules:\n  - path_regex: ${ruleRegex("staging")}\n    age: ${RECIPIENT}\n    encrypted_regex: ^data$\n`,
    })
    const second = createContext({ run: keygen().run })
    await ageInit({ environment: "staging", paths: other.paths }, second.context)
    expect(second.output()).toContain("set encrypted_regex to ^(data|stringData)$.")
    expect(second.output()).not.toContain("keeps the form")
  })

  test("fails when age-keygen fails or answers no recipient", async () => {
    const { paths } = await fixture()
    const broken = createFakeRunner(() => ({ exitCode: 1, stderr: "no space\n" }))
    await expect(ageInit({ environment: "staging", paths }, createContext({ run: broken.run }).context)).rejects.toThrow(
      "age-keygen failed with exit code 1: no space",
    )
    const silent = createFakeRunner(async (call) => {
      if (call.argv[1] === "-o") await writeFile(call.argv[2]!, "key")
      return { stdout: "not a recipient" }
    })
    await expect(ageInit({ environment: "staging", paths }, createContext({ run: silent.run }).context)).rejects.toThrow(
      "could not read a recipient",
    )
  })

  test("refuses a .sops.yaml it cannot read", async () => {
    for (const [text, message] of [
      ["creation_rules: [", "is not YAML"],
      ["- a\n- b\n", "must be a mapping"],
      ["creation_rules: 3\n", "creation_rules must be a list"],
    ]) {
      const { paths } = await fixture({ ".sops.yaml": text! })
      await expect(ageInit({ environment: "staging", paths }, createContext({ run: keygen().run }).context)).rejects.toThrow(message!)
    }
  })

  test("accepts an empty .sops.yaml", async () => {
    const { paths } = await fixture({ ".sops.yaml": "" })
    await ageInit({ environment: "staging", paths }, createContext({ run: keygen().run }).context)
    expect((Bun.YAML.parse(await readFile(paths.sopsConfig, "utf8")) as { creation_rules: unknown[] }).creation_rules).toHaveLength(1)
  })
})

describe("formatConfig", () => {
  test("writes other keys and values that need quoting as JSON, which YAML reads back unchanged", () => {
    const config = {
      rest: { stores: { yaml: { indent: 2 } } },
      rules: [{ path_regex: "^weird: path$", age: RECIPIENT, encrypted_regex: "^(data|stringData)$", shamir_threshold: 1 }],
    }
    const text = formatConfig(config)
    expect(text).toStartWith("# sops' creation rules")
    expect(Bun.YAML.parse(text)).toEqual({ stores: { yaml: { indent: 2 } }, creation_rules: config.rules })
  })
})
