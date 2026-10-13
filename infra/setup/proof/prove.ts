// The setup commands' real-tool paths, proved once on this machine with no account (infra/setup/README.md, Prove):
// age-init with the real age-keygen against a throwaway .sops.yaml and key directory; init-secrets encrypting and
// decrypting with the real sops and that key, with Terraform's output faked; origin-pull with the real openssl and a
// fake Cloudflare; database-ca against PostgreSQL 17 with TLS in Docker, from this machine and through the pod
// command's script in a container. Needs age-keygen, sops, OpenSSL 3 and Docker. Removes everything it made.
import { createPrivateKey, createPublicKey, X509Certificate } from "node:crypto"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { main, systemDeps, type CliDeps } from "../src/cli"
import { FETCH_IMAGE, fetchScript } from "../src/database-ca"
import { pathsFor } from "../src/environments"
import { parseSecrets } from "../src/secrets"
import { systemRunner, type Runner } from "../src/run"

const POSTGRES = "postgres:17.11-alpine@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24"
const ADMIN_URL = "postgres://dbadmin:proof-password@10.10.0.5:5432/postgres?sslmode=verify-full&sslrootcert=/etc/ssl/db/ca.pem"

const results: { name: string; ok: boolean; detail: string }[] = []
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail })
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`)
}

async function must(argv: string[], options: Parameters<Runner>[1] = {}) {
  const result = await systemRunner(argv, options)
  if (result.exitCode !== 0) throw new Error(`${argv.join(" ")} exited ${result.exitCode}: ${result.stderr.trim()}`)
  return result.stdout
}

// Terraform as the commands see it after an apply: the outputs a test environment would have.
function withTerraform(outputs: Record<string, string>): Runner {
  return async (argv, options) => {
    if (argv[0] !== "terraform") return systemRunner(argv, options)
    if (argv[1] === "output") return { exitCode: 0, stdout: outputs[argv[3]!] ?? "", stderr: "" }
    return { exitCode: 0, stdout: "", stderr: "" }
  }
}

async function setup(root: string, argv: string[], overrides: Partial<CliDeps> = {}) {
  const printed: string[] = []
  const deps: CliDeps = {
    ...systemDeps(),
    root,
    home: join(root, "home"),
    out: (text) => printed.push(text),
    err: (text) => printed.push(text),
    ...overrides,
  }
  const code = await main(argv, deps)
  return { code, output: printed.join("") }
}

async function proveAgeAndSecrets(root: string) {
  const config = join(root, "throwaway/.sops.yaml")
  const keys = join(root, "throwaway/keys")
  const moved = ["--sops-config", config, "--key-dir", keys]
  const staging = await setup(root, ["age-init", "--environment", "staging", ...moved])
  const key = join(keys, "answerable-staging.txt")
  check("age-init creates the key with mode 600", staging.code === 0 && ((await stat(key)).mode & 0o777) === 0o600)
  check("age-init never prints the private key", !staging.output.includes("AGE-SECRET-KEY"))
  const production = await setup(root, ["age-init", "--environment", "production", ...moved])
  const again = await setup(root, ["age-init", "--environment", "staging", ...moved])
  const rules = (Bun.YAML.parse(await readFile(config, "utf8")) as { creation_rules: { path_regex: string; age: string }[] }).creation_rules
  check(
    "age-init writes one rule per environment and keeps the other",
    production.code === 0 && again.code === 0 && rules.length === 2 && again.output.includes("unchanged"),
    rules.map((rule) => rule.path_regex).join(", "),
  )
  check("the rule's recipient is the key's", rules[0]!.age === (await must(["age-keygen", "-y", key])).trim())
  check("the real .sops.yaml is untouched", !(await Bun.file(join(root, ".sops.yaml")).exists()))

  const env = {
    ...process.env,
    AWS_ACCESS_KEY_ID: "proof-key-id",
    AWS_SECRET_ACCESS_KEY: "proof-state-secret",
    CERT_MANAGER_CLOUDFLARE_TOKEN: "proof-cert-manager-token",
    CLOUDFLARE_API_TOKEN: "proof-terraform-token",
    MICROSOFT_CLIENT_ID: "proof-microsoft-id",
    MICROSOFT_CLIENT_SECRET: "proof-microsoft-secret",
  }
  const run = withTerraform({ database_admin_url: ADMIN_URL })
  const made = await setup(root, ["init-secrets", "--environment", "staging", ...moved], { env, run })
  const paths = pathsFor("staging", { root, home: root, sopsConfig: config, keyDir: keys })
  const encrypted = await readFile(paths.secretsFile, "utf8")
  check(
    "init-secrets writes and verifies the file",
    made.code === 0 && made.output.includes("Verified"),
    made.code ? made.output.trim().split("\n").at(-1) : "",
  )
  check(
    "the file holds no value in plain text",
    !["proof-cert-manager-token", "proof-microsoft-secret", "proof-password"].some((value) => encrypted.includes(value)) &&
      encrypted.includes("ENC["),
  )
  check(
    "init-secrets prints no value",
    !["proof-cert-manager-token", "proof-microsoft-secret", "proof-password", "proof-state-secret"].some((value) =>
      made.output.includes(value),
    ),
  )
  const decrypted = await must(["sops", "--config", config, "decrypt", paths.secretsFile], { env: { SOPS_AGE_KEY_FILE: key } })
  const data = parseSecrets(decrypted, "secrets.enc.yaml")
  check("sops decrypts it to the three Secrets", decrypted.split("\n---\n").length === 3, Object.keys(data).join(", "))
  check("the admin URL is Terraform's", data["postgres-admin"].OPS_DATABASE_ADMIN_URL === ADMIN_URL)
  check(
    "the upstream key is 32 bytes, base64url",
    /^\[\{"version":1,"value":"[A-Za-z0-9_-]{43}"\}\]$/.test(data["id-env"].UPSTREAM_TOKEN_SECRETS!),
  )
  check("the root secret is 48 bytes", Buffer.from(data["id-env"].ROOT_ADMIN_SECRET!, "base64").length === 48)
  const refused = await setup(root, ["init-secrets", "--environment", "staging", ...moved], { env, run })
  check("init-secrets refuses to overwrite", refused.code === 1 && refused.output.includes("exists"))
  const rotated = await setup(root, ["init-secrets", "--environment", "staging", "--rotate", "UPSTREAM_TOKEN_SECRETS", ...moved], {
    env,
    run,
  })
  const after = parseSecrets(
    await must(["sops", "--config", config, "decrypt", paths.secretsFile], { env: { SOPS_AGE_KEY_FILE: key } }),
    "x",
  )
  const ring = JSON.parse(after["id-env"].UPSTREAM_TOKEN_SECRETS!) as { version: number }[]
  check(
    "--rotate puts a new upstream key first and changes nothing else",
    rotated.code === 0 &&
      ring.map((entry) => entry.version).join() === "2,1" &&
      after["id-env"].ROOT_ADMIN_SECRET === data["id-env"].ROOT_ADMIN_SECRET,
  )
}

async function proveOriginPull(root: string) {
  const uploads: { certificate: string; private_key: string }[] = []
  let polls = 0
  const fetch = async (url: string, init: RequestInit = {}) => {
    const answer = (result: unknown) => Response.json({ success: true, errors: [], result })
    if (url.endsWith("/zones?name=answerable-staging.uk")) return answer([{ id: "zone-proof", name: "answerable-staging.uk" }])
    if (init.method === "POST") {
      uploads.push(JSON.parse(String(init.body)))
      return answer({ id: `cert-${uploads.length}`, status: "pending_deployment" })
    }
    if (url.endsWith("/origin_tls_client_auth")) return answer(uploads.map((_, index) => ({ id: `cert-${index + 1}`, status: "active" })))
    polls += 1
    return answer({ status: "active" })
  }
  const temporary: string[] = []
  const run: Runner = async (argv, options) => {
    if (options?.cwd?.includes("answerable-origin-pull-")) temporary.push(options.cwd)
    return systemRunner(argv, options)
  }
  const env = { ...process.env, CLOUDFLARE_API_TOKEN: "proof-token" }
  const first = await setup(root, ["origin-pull", "--environment", "staging", "--zone", "answerable-staging.uk"], {
    fetch,
    run,
    env,
    sleep: async () => {},
  })
  const paths = pathsFor("staging", { root, home: root })
  check(
    "origin-pull uploads one certificate and writes ca.pem",
    first.code === 0 && uploads.length === 1 && polls === 1,
    first.code ? first.output.slice(-300) : "",
  )
  const ca = new X509Certificate(await readFile(paths.edgeCa, "utf8"))
  const client = new X509Certificate(uploads[0]!.certificate)
  const key = createPrivateKey(uploads[0]!.private_key)
  const days = (certificate: X509Certificate) =>
    Math.round((Date.parse(certificate.validTo) - Date.parse(certificate.validFrom)) / 86_400_000)
  check(
    "the CA is a P-256 CA for ten years",
    ca.ca && ca.publicKey.asymmetricKeyDetails?.namedCurve === "prime256v1" && days(ca) === 3650,
    `${days(ca)} days`,
  )
  check("ca.pem holds the public certificate only", !(await readFile(paths.edgeCa, "utf8")).includes("PRIVATE"))
  check(
    "the client is signed by the CA, P-256, five years",
    client.verify(ca.publicKey) && !client.ca && days(client) === 1825,
    `${days(client)} days`,
  )
  check("the client's CN names the zone", client.subject === "CN=cloudflare-origin-pull.answerable-staging.uk")
  check(
    "the uploaded key is the client's",
    key.asymmetricKeyDetails?.namedCurve === "prime256v1" &&
      createPublicKey(key)
        .export({ type: "spki", format: "der" })
        .equals(client.publicKey.export({ type: "spki", format: "der" })),
  )
  check(
    "the temporary directory is gone",
    temporary.length > 0 && !(await Promise.all(temporary.map((path) => Bun.file(join(path, "ca.key")).exists()))).some(Boolean),
  )
  check("no private key was printed", !first.output.includes("PRIVATE KEY"))

  let during = ""
  const rotation = await setup(root, ["origin-pull", "--environment", "staging", "--zone", "answerable-staging.uk", "--force"], {
    fetch,
    run,
    env,
    sleep: async () => {},
    ask: async () => {
      during = await readFile(paths.edgeCa, "utf8")
      return ""
    },
  })
  const final = await readFile(paths.edgeCa, "utf8")
  check(
    "--force trusts both CAs during the apply, then keeps the new one",
    rotation.code === 0 &&
      (during.match(/BEGIN CERTIFICATE/g) ?? []).length === 2 &&
      new X509Certificate(final).fingerprint256 !== ca.fingerprint256,
  )
  check("--force prints how to delete the old certificate", rotation.output.includes("origin_tls_client_auth/cert-1"))
}

async function proveDatabaseCa(root: string) {
  const certs = join(root, "postgres-tls")
  await must(["mkdir", "-p", certs])
  const ec = ["-algorithm", "EC", "-pkeyopt", "ec_paramgen_curve:P-256"]
  await must(["openssl", "genpkey", ...ec, "-out", "ca.key"], { cwd: certs })
  await must(
    ["openssl", "req", "-x509", "-new", "-key", "ca.key", "-sha256", "-days", "30", "-subj", "/CN=Proof database CA", "-out", "ca.pem"],
    { cwd: certs },
  )
  await must(["openssl", "genpkey", ...ec, "-out", "server.key"], { cwd: certs })
  await must(["openssl", "req", "-new", "-key", "server.key", "-subj", "/CN=pg", "-out", "server.csr"], { cwd: certs })
  await Bun.write(join(certs, "server.ext"), "subjectAltName=DNS:pg,DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n")
  await must(
    [
      "openssl",
      "x509",
      "-req",
      "-in",
      "server.csr",
      "-CA",
      "ca.pem",
      "-CAkey",
      "ca.key",
      "-set_serial",
      "7",
      "-days",
      "30",
      "-sha256",
      "-extfile",
      "server.ext",
      "-out",
      "server.pem",
    ],
    { cwd: certs },
  )
  const caPem = await readFile(join(certs, "ca.pem"), "utf8")
  const chain = `${await readFile(join(certs, "server.pem"), "utf8")}${caPem}`
  const suffix = crypto.randomUUID().slice(0, 8)
  const network = `answerable-setup-proof-${suffix}`
  const container = `answerable-setup-proof-pg-${suffix}`
  try {
    await must(["docker", "network", "create", network])
    // The image starts as root: copy the throwaway certificate and key where postgres owns them, then start it TLS-only.
    const start = [
      'printf "%s" "$TLS_CHAIN" > /tmp/server.crt && printf "%s" "$TLS_KEY" > /tmp/server.key',
      "chown postgres:postgres /tmp/server.crt /tmp/server.key && chmod 600 /tmp/server.key",
      "exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/tmp/server.crt -c ssl_key_file=/tmp/server.key",
    ].join(" && ")
    await must([
      "docker",
      "run",
      "-d",
      "--name",
      container,
      "--network",
      network,
      "--network-alias",
      "pg",
      "-p",
      "127.0.0.1::5432",
      "-e",
      "POSTGRES_PASSWORD=proof",
      "-e",
      `TLS_CHAIN=${chain}`,
      "-e",
      `TLS_KEY=${await readFile(join(certs, "server.key"), "utf8")}`,
      "--entrypoint",
      "sh",
      POSTGRES,
      "-c",
      start,
    ])
    const port = (await must(["docker", "port", container, "5432/tcp"])).trim().split(":").at(-1)!
    let ready = false
    for (let attempt = 0; attempt < 60 && !ready; attempt += 1) {
      ready = (await systemRunner(["docker", "exec", container, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"])).exitCode === 0
      if (!ready) await Bun.sleep(1000)
    }
    check("TLS PostgreSQL 17 is up", ready, `127.0.0.1:${port}`)

    const env = { ...process.env, AWS_ACCESS_KEY_ID: "proof-key-id", AWS_SECRET_ACCESS_KEY: "proof-state-secret" }
    const paths = pathsFor("staging", { root, home: root })
    const direct = await setup(root, ["database-ca", "--environment", "staging"], {
      env,
      run: withTerraform({ database_host: "127.0.0.1", database_port: port }),
    })
    const kept = await readFile(paths.databaseCa, "utf8").catch(() => "")
    check(
      "database-ca keeps the root of the presented chain",
      direct.code === 0 && kept === caPem,
      direct.code ? direct.output.slice(-400) : "",
    )
    check(
      "it prints the fingerprint and says trust on first use",
      direct.output.includes(new X509Certificate(caPem).fingerprint256) && direct.output.includes("trust on first use"),
    )
    check("it checks the host against the server's names", direct.output.includes("It covers 127.0.0.1"))

    const closed = await setup(root, ["database-ca", "--environment", "staging", "--force"], {
      env,
      run: withTerraform({ database_host: "127.0.0.1", database_port: "1" }),
    })
    check(
      "an unreachable database prints the pod command",
      closed.code === 1 && closed.output.includes("kubectl --kubeconfig admin.kubeconfig run database-ca"),
    )

    // The pod command's own script, in the same image, on the database's network: what an operator pipes in.
    const fetched = await must(["docker", "run", "--rm", "--network", network, FETCH_IMAGE, "sh", "-c", fetchScript("pg", "5432")])
    const piped = await setup(root, ["database-ca", "--environment", "staging", "--from-stdin", "--force"], {
      readStdin: async () => fetched,
    })
    check(
      "the pod command's script fetches the chain for --from-stdin",
      piped.code === 0 && (await readFile(paths.databaseCa, "utf8")) === caPem,
      piped.code ? piped.output.slice(-300) : "",
    )
  } finally {
    await systemRunner(["docker", "rm", "-f", "-v", container])
    await systemRunner(["docker", "network", "rm", network])
    const left = await systemRunner(["docker", "ps", "-a", "--filter", `name=${container}`, "--format", "{{.Names}}"])
    check("the container and network are removed", left.stdout.trim() === "")
  }
}

const root = await mkdtemp(join(tmpdir(), "answerable-setup-proof-"))
try {
  await Bun.write(join(root, "infra/civo/envs/staging/.terraform/terraform.tfstate"), "{}")
  console.log("age-init and init-secrets, with the real age-keygen and sops:")
  await proveAgeAndSecrets(root)
  console.log("\norigin-pull, with the real openssl and a fake Cloudflare:")
  await proveOriginPull(root)
  console.log("\ndatabase-ca, against PostgreSQL 17 with TLS in Docker:")
  await proveDatabaseCa(root)
} catch (error) {
  check("the proof ran to the end", false, error instanceof Error ? error.message : String(error))
} finally {
  await rm(root, { recursive: true, force: true })
}
const failed = results.filter((result) => !result.ok)
console.log(`\n${results.length - failed.length} of ${results.length} checks passed.`)
process.exitCode = failed.length ? 1 : 0
