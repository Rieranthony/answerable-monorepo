import { afterEach, describe, expect, test } from "bun:test"
import { readFile, writeFile } from "node:fs/promises"
import { pathsFor, type Paths } from "./environments"
import { formatSecrets, initSecrets, parseSecrets, readAgeKey, readRootSecret, type SecretsData } from "./secrets"
import { createContext, createFakeRunner, createRoot, type RecordedCall } from "./testing"
import type { RunResult } from "./run"

const ADMIN_URL = "postgres://dbadmin:p%40ss@10.10.0.5:5432/postgres?sslmode=verify-full&sslrootcert=/etc/ssl/db/ca.pem"
const ENV = {
  AWS_ACCESS_KEY_ID: "key-id",
  AWS_SECRET_ACCESS_KEY: "state-secret",
  CERT_MANAGER_CLOUDFLARE_TOKEN: "cert-manager-token",
  CLOUDFLARE_API_TOKEN: "terraform-token",
}
const SOPS_CONFIG = "creation_rules:\n  - path_regex: infra/civo/envs/staging/secrets\\.enc\\.yaml$\n    age: age1x\n"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

/**
 * `sops` and `terraform` as these commands see them: encryption wraps the text in a marker the fake decryption
 * unwraps from the file, so a test can read what was written; Terraform answers the admin URL.
 */
function fakeTools(override: (call: RecordedCall) => Partial<RunResult> | undefined = () => undefined) {
  return createFakeRunner(async (call) => {
    const answer = override(call)
    if (answer) return answer
    if (call.argv[0] === "terraform") return { stdout: call.argv[1] === "output" ? `${ADMIN_URL}\n` : "" }
    if (call.argv[3] === "encrypt") return { stdout: `${Buffer.from(call.options.input!).toString("base64")}\nsops:\n  age: []\n` }
    if (call.argv[3] === "decrypt") {
      const text = await readFile(call.argv[4]!, "utf8")
      return { stdout: Buffer.from(text.split("\n")[0]!, "base64").toString("utf8") }
    }
    return undefined
  })
}

async function fixture(files: Record<string, string> = {}) {
  const root = await createRoot({ ".sops.yaml": SOPS_CONFIG, "infra/civo/envs/staging/.terraform/terraform.tfstate": "{}", ...files })
  cleanups.push(root.remove)
  return pathsFor("staging", { root: root.path, home: root.path })
}

async function written(paths: Paths): Promise<SecretsData> {
  const text = await readFile(paths.secretsFile, "utf8")
  return parseSecrets(Buffer.from(text.split("\n")[0]!, "base64").toString("utf8"), "test")
}

describe("init-secrets", () => {
  test("builds the three Secrets in memory, encrypts them under the environment's rule and verifies the file", async () => {
    const paths = await fixture({ "home/.config/sops/age/answerable-staging.txt": "AGE-SECRET-KEY-1X\n" })
    const keyed = { ...paths, keyFile: `${paths.root}/home/.config/sops/age/answerable-staging.txt` }
    const runner = fakeTools()
    const env = { ...ENV, MICROSOFT_CLIENT_ID: "ms-id", MICROSOFT_CLIENT_SECRET: "ms-secret" }
    const { context, output } = createContext({ run: runner.run, env })
    await initSecrets({ environment: "staging", paths: keyed }, context)

    expect(runner.commands()).toEqual([
      "terraform output -raw database_admin_url",
      `sops --config ${paths.sopsConfig} encrypt --filename-override ${paths.secretsFile}`,
      `sops --config ${paths.sopsConfig} decrypt ${paths.secretsFile}`,
    ])
    expect(runner.calls[0]!.options.env).toEqual({ AWS_ACCESS_KEY_ID: "key-id", AWS_SECRET_ACCESS_KEY: "state-secret" })
    expect(runner.calls[2]!.options.env).toEqual({ SOPS_AGE_KEY_FILE: keyed.keyFile })
    const data = await written(paths)
    expect(Object.keys(data["id-env"])).toEqual([
      "BETTER_AUTH_SECRET", "UPSTREAM_TOKEN_SECRETS", "ROOT_ADMIN_SECRET", "MICROSOFT_CLIENT_ID", "MICROSOFT_CLIENT_SECRET",
    ])
    expect(Buffer.from(data["id-env"].BETTER_AUTH_SECRET!, "base64")).toHaveLength(48)
    expect(Buffer.from(data["id-env"].ROOT_ADMIN_SECRET!, "base64")).toHaveLength(48)
    expect(data["id-env"].ROOT_ADMIN_SECRET).not.toBe(data["id-env"].BETTER_AUTH_SECRET)
    const [upstream] = JSON.parse(data["id-env"].UPSTREAM_TOKEN_SECRETS!)
    expect(upstream.version).toBe(1)
    expect(upstream.value).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(data["postgres-admin"]).toEqual({ OPS_DATABASE_ADMIN_URL: ADMIN_URL })
    expect(data["cloudflare-api-token"]).toEqual({ "api-token": "cert-manager-token" })

    const plain = runner.calls[1]!.options.input!
    expect(plain).toContain("---\napiVersion: v1\nkind: Secret\nmetadata:\n  name: postgres-admin\n  namespace: answerable\ntype: Opaque\n")
    for (const value of [...Object.values(data["id-env"]), ADMIN_URL, "cert-manager-token"]) expect(output()).not.toContain(value)
    expect(output()).toContain("  id-env: BETTER_AUTH_SECRET, UPSTREAM_TOKEN_SECRETS, ROOT_ADMIN_SECRET, MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET\n")
    expect(output()).toContain("No GOOGLE_CLIENT_ID yet: set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, then run init-secrets --rotate GOOGLE_CLIENT_SECRET")
    expect(output()).not.toContain("No MICROSOFT_CLIENT_ID")
  })

  test("refuses to overwrite the file unless forced, and then makes every value new", async () => {
    const paths = await fixture()
    await initSecrets({ environment: "staging", paths }, createContext({ run: fakeTools().run, env: ENV }).context)
    const first = await written(paths)
    await expect(initSecrets({ environment: "staging", paths }, createContext({ run: fakeTools().run, env: ENV }).context)).rejects.toThrow(
      "secrets.enc.yaml exists. --rotate <key> replaces one value; --force replaces them all",
    )
    await initSecrets({ environment: "staging", paths, force: true }, createContext({ run: fakeTools().run, env: ENV }).context)
    expect((await written(paths))["id-env"].ROOT_ADMIN_SECRET).not.toBe(first["id-env"].ROOT_ADMIN_SECRET)
  })

  test("refuses half a pair, a missing or reused cert-manager token, and a URL without verify-full", async () => {
    const paths = await fixture()
    const run = fakeTools().run
    await expect(initSecrets({ environment: "staging", paths }, createContext({ run, env: { ...ENV, GOOGLE_CLIENT_ID: "g" } }).context)).rejects.toThrow(
      "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET go together",
    )
    await expect(
      initSecrets({ environment: "staging", paths }, createContext({ run, env: { ...ENV, CERT_MANAGER_CLOUDFLARE_TOKEN: "" } }).context),
    ).rejects.toThrow("CERT_MANAGER_CLOUDFLARE_TOKEN is not set")
    await expect(
      initSecrets({ environment: "staging", paths }, createContext({ run, env: { ...ENV, CERT_MANAGER_CLOUDFLARE_TOKEN: "terraform-token" } }).context),
    ).rejects.toThrow("CERT_MANAGER_CLOUDFLARE_TOKEN is Terraform's token")
    const plain = fakeTools((call) => (call.argv[0] === "terraform" ? { stdout: "postgres://dbadmin:pw@host/postgres" } : undefined))
    const failure = initSecrets({ environment: "staging", paths }, createContext({ run: plain.run, env: ENV }).context)
    await expect(failure).rejects.toThrow("Terraform's database_admin_url is not a postgres:// URL with sslmode=verify-full")
    await expect(failure).rejects.not.toThrow("dbadmin:pw")
  })

  test("needs .sops.yaml, and stops when sops fails or the file does not read back", async () => {
    const bare = await createRoot({ "infra/civo/envs/staging/.terraform/terraform.tfstate": "{}" })
    cleanups.push(bare.remove)
    const paths = pathsFor("staging", { root: bare.path, home: bare.path })
    await expect(initSecrets({ environment: "staging", paths }, createContext({ run: fakeTools().run, env: ENV }).context)).rejects.toThrow(
      ".sops.yaml does not exist: run age-init first",
    )
    const configured = await fixture()
    const refusing = fakeTools((call) => (call.argv[3] === "encrypt" ? { exitCode: 128, stderr: "no matching creation rules found" } : undefined))
    await expect(initSecrets({ environment: "staging", paths: configured }, createContext({ run: refusing.run, env: ENV }).context)).rejects.toThrow(
      "sops could not encrypt (exit 128): no matching creation rules found",
    )
    const changed = fakeTools((call) => {
      if (call.argv[3] !== "decrypt") return undefined
      const data = parseSecrets(Buffer.from(call.options.input ?? "", "base64").toString() || formatSecrets(sample()), "x")
      data["id-env"].ROOT_ADMIN_SECRET = "other"
      return { stdout: formatSecrets(data) }
    })
    await expect(
      initSecrets({ environment: "staging", paths: configured, force: true }, createContext({ run: changed.run, env: ENV }).context),
    ).rejects.toThrow("does not decrypt to what was written; do not commit it")
    const locked = fakeTools((call) => (call.argv[3] === "decrypt" ? { exitCode: 1, stderr: "failed to get the data key" } : undefined))
    await expect(
      initSecrets({ environment: "staging", paths: configured, force: true }, createContext({ run: locked.run, env: ENV }).context),
    ).rejects.toThrow("sops could not decrypt infra/civo/envs/staging/secrets.enc.yaml (exit 1): failed to get the data key.")
  })
})

function sample(): SecretsData {
  return {
    "id-env": { BETTER_AUTH_SECRET: "a", UPSTREAM_TOKEN_SECRETS: '[{"version":1,"value":"v1"}]', ROOT_ADMIN_SECRET: "root" },
    "postgres-admin": { OPS_DATABASE_ADMIN_URL: "postgres://old" },
    "cloudflare-api-token": { "api-token": "old-token" },
  }
}

describe("init-secrets --rotate", () => {
  async function seeded(data = sample()) {
    const paths = await fixture()
    await writeFile(paths.secretsFile, `${Buffer.from(formatSecrets(data)).toString("base64")}\nsops:\n`)
    return paths
  }

  test("replaces only the root secret", async () => {
    const paths = await seeded()
    const { context, output } = createContext({ run: fakeTools().run, env: ENV })
    await initSecrets({ environment: "staging", paths, rotate: "ROOT_ADMIN_SECRET" }, context)
    const data = await written(paths)
    expect(data["id-env"].ROOT_ADMIN_SECRET).not.toBe("root")
    expect({ ...data, "id-env": { ...data["id-env"], ROOT_ADMIN_SECRET: "root" } }).toEqual(sample())
    expect(output()).toContain("Replaced ROOT_ADMIN_SECRET in infra/civo/envs/staging/secrets.enc.yaml")
  })

  test("puts a new upstream key first and keeps the previous ones for reading", async () => {
    const paths = await seeded()
    await initSecrets({ environment: "staging", paths, rotate: "UPSTREAM_TOKEN_SECRETS" }, createContext({ run: fakeTools().run, env: ENV }).context)
    const ring = JSON.parse((await written(paths))["id-env"].UPSTREAM_TOKEN_SECRETS!)
    expect(ring).toHaveLength(2)
    expect(ring[0].version).toBe(2)
    expect(ring[1]).toEqual({ version: 1, value: "v1" })
  })

  test("takes the admin URL from Terraform, the token and the pairs from the environment", async () => {
    const paths = await seeded()
    const env = { ...ENV, CERT_MANAGER_CLOUDFLARE_TOKEN: "new-token", GOOGLE_CLIENT_ID: "g-id", GOOGLE_CLIENT_SECRET: "g-secret" }
    for (const field of ["OPS_DATABASE_ADMIN_URL", "api-token", "GOOGLE_CLIENT_ID"])
      await initSecrets({ environment: "staging", paths, rotate: field }, createContext({ run: fakeTools().run, env }).context)
    const data = await written(paths)
    expect(data["postgres-admin"].OPS_DATABASE_ADMIN_URL).toBe(ADMIN_URL)
    expect(data["cloudflare-api-token"]["api-token"]).toBe("new-token")
    expect(data["id-env"]).toMatchObject({ GOOGLE_CLIENT_ID: "g-id", GOOGLE_CLIENT_SECRET: "g-secret" })
  })

  test("refuses BETTER_AUTH_SECRET, unknown keys, an unset pair, a missing file and a broken key ring", async () => {
    const paths = await seeded()
    const run = fakeTools().run
    await expect(initSecrets({ environment: "staging", paths, rotate: "BETTER_AUTH_SECRET" }, createContext({ run, env: ENV }).context)).rejects.toThrow(
      "Rotate it through BETTER_AUTH_SECRETS",
    )
    await expect(initSecrets({ environment: "staging", paths, rotate: "PASSWORD" }, createContext({ run, env: ENV }).context)).rejects.toThrow(
      "--rotate takes one of ROOT_ADMIN_SECRET, UPSTREAM_TOKEN_SECRETS",
    )
    await expect(
      initSecrets({ environment: "staging", paths, rotate: "MICROSOFT_CLIENT_SECRET" }, createContext({ run, env: ENV }).context),
    ).rejects.toThrow("MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET are not set")
    const empty = await fixture()
    await expect(initSecrets({ environment: "staging", paths: empty, rotate: "ROOT_ADMIN_SECRET" }, createContext({ run, env: ENV }).context)).rejects.toThrow(
      "does not exist: run init-secrets without --rotate first",
    )
    for (const ring of ["not json", '[{"value":"x"}]', '{"version":1}']) {
      const broken = sample()
      broken["id-env"].UPSTREAM_TOKEN_SECRETS = ring
      const brokenPaths = await seeded(broken)
      await expect(
        initSecrets({ environment: "staging", paths: brokenPaths, rotate: "UPSTREAM_TOKEN_SECRETS" }, createContext({ run, env: ENV }).context),
      ).rejects.toThrow("is not a list of versioned keys")
    }
  })
})

describe("parseSecrets", () => {
  test("reads one document, and names every problem without a value", () => {
    expect(() => parseSecrets("{", "f")).toThrow("f is not YAML")
    const single = formatSecrets(sample()).split("---\n")[0]!
    expect(() => parseSecrets(single, "f")).toThrow("f does not hold the three Secrets: no postgres-admin; no cloudflare-api-token")
    const bad = [
      formatSecrets(sample()),
      "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: x\n",
      "kind: Secret\nmetadata:\n  name: id-env\n  namespace: default\ntype: kubernetes.io/tls\nstringData:\n  BETTER_AUTH_SECRET: ''\n  MICROSOFT_CLIENT_ID: 'x'\n",
      "kind: Secret\nmetadata:\n  name: postgres-admin\n  namespace: answerable\ntype: Opaque\n",
    ].join("\n---\n")
    expect(() => parseSecrets(bad, "f")).toThrow(
      "an unexpected document (ConfigMap x); id-env twice; id-env outside the answerable namespace; id-env not of type Opaque; " +
        "id-env.BETTER_AUTH_SECRET empty or not a string; postgres-admin twice; id-env.BETTER_AUTH_SECRET missing; " +
        "id-env.UPSTREAM_TOKEN_SECRETS missing; id-env.ROOT_ADMIN_SECRET missing; postgres-admin.OPS_DATABASE_ADMIN_URL missing; " +
        "id-env has half of MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET",
    )
    expect(() => parseSecrets("---\n", "f")).toThrow("no id-env")
  })

  test("quotes keys that are not plain words", () => {
    const data = sample()
    data["cloudflare-api-token"]["odd key"] = "v"
    expect(formatSecrets(data)).toContain('  "odd key": "v"')
    expect(parseSecrets(formatSecrets(data), "f")["cloudflare-api-token"]["odd key"]).toBe("v")
  })
})

describe("readRootSecret and readAgeKey", () => {
  test("read the root secret into memory and the age key without its comments", async () => {
    const paths = await fixture({ "key.txt": "# created: now\n# public key: age1x\nAGE-SECRET-KEY-1ABC\n", "bad.txt": "# nothing\n" })
    await writeFile(paths.secretsFile, `${Buffer.from(formatSecrets(sample())).toString("base64")}\nsops:\n`)
    expect(await readRootSecret(createContext({ run: fakeTools().run }).context, paths)).toBe("root")
    expect(await readAgeKey({ ...paths, keyFile: `${paths.root}/key.txt` })).toBe("AGE-SECRET-KEY-1ABC")
    await expect(readAgeKey({ ...paths, keyFile: `${paths.root}/bad.txt` })).rejects.toThrow("holds no AGE-SECRET-KEY line")
    await expect(readAgeKey(paths)).rejects.toThrow("does not exist: run age-init first")
    const empty = await fixture()
    await expect(readRootSecret(createContext().context, empty)).rejects.toThrow("does not exist: run init-secrets first")
  })
})
