import { readFile, writeFile } from "node:fs/promises"
import { exists, requireVariable, type Context } from "./context"
import { NAMESPACE, shown, type EnvironmentName, type Paths } from "./environments"
import { SetupError, UsageError } from "./errors"
import { decrypt, encrypt } from "./sops"
import { readOutput, stateEnv } from "./terraform"

/** The three Secrets of the `sops` file, in the order they are written (the first-run contract). */
const SECRET_NAMES = ["id-env", "postgres-admin", "cloudflare-api-token"] as const

type SecretName = (typeof SECRET_NAMES)[number]

/** Each Secret's `stringData`. */
export type SecretsData = Record<SecretName, Record<string, string>>

const REQUIRED: Record<SecretName, string[]> = {
  "id-env": ["BETTER_AUTH_SECRET", "UPSTREAM_TOKEN_SECRETS", "ROOT_ADMIN_SECRET"],
  "postgres-admin": ["OPS_DATABASE_ADMIN_URL"],
  "cloudflare-api-token": ["api-token"],
}

/** The platform applications' credentials: each pair is in `id-env` together or not at all. */
const PAIRS = [
  ["MICROSOFT_CLIENT_ID", "MICROSOFT_CLIENT_SECRET"],
  ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
] as const

/** Keys `--rotate` can replace, and where each new value comes from. */
const ROTATABLE = [
  "ROOT_ADMIN_SECRET",
  "UPSTREAM_TOKEN_SECRETS",
  "OPS_DATABASE_ADMIN_URL",
  "api-token",
  ...PAIRS.flat(),
] as const

function random(bytes: number): Buffer {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes)))
}

/** 48 random bytes, base64: `BETTER_AUTH_SECRET` and `ROOT_ADMIN_SECRET` (docs/06, Configuration). */
function secret48(): string {
  return random(48).toString("base64")
}

/** A versioned upstream-token key: 32 random bytes, canonical base64url without padding, 43 characters. */
function upstreamKey(version: number): { version: number; value: string } {
  return { version, value: random(32).toString("base64url") }
}

function key(name: string): string {
  return /^[A-Za-z_][\w-]*$/.test(name) ? name : JSON.stringify(name)
}

/** The Secrets as multi-document YAML: three `Secret` manifests, values as JSON strings (which YAML reads unchanged). */
export function formatSecrets(data: SecretsData): string {
  return SECRET_NAMES.map((name) =>
    [
      "apiVersion: v1",
      "kind: Secret",
      "metadata:",
      `  name: ${name}`,
      `  namespace: ${NAMESPACE}`,
      "type: Opaque",
      "stringData:",
      ...Object.entries(data[name]).map(([field, value]) => `  ${key(field)}: ${JSON.stringify(value)}`),
    ].join("\n"),
  ).join("\n---\n").concat("\n")
}

/**
 * Read decrypted Secrets and check them: exactly the three Secrets in `answerable`, each `Opaque`, with every key
 * the contract names holding a non-empty string and each platform pair complete. Problems name keys, never values.
 */
export function parseSecrets(text: string, label: string): SecretsData {
  let parsed: unknown
  try {
    parsed = Bun.YAML.parse(text)
  } catch {
    throw new SetupError(`${label} is not YAML`)
  }
  const documents = (Array.isArray(parsed) ? parsed : [parsed]).filter((document) => document !== null)
  const problems: string[] = []
  const data: Partial<SecretsData> = {}
  for (const document of documents) {
    const manifest = document as { kind?: unknown; type?: unknown; metadata?: { name?: unknown; namespace?: unknown }; stringData?: unknown }
    const name = SECRET_NAMES.find((candidate) => candidate === manifest?.metadata?.name)
    if (manifest?.kind !== "Secret" || !name) {
      problems.push(`an unexpected document (${String(manifest?.kind)} ${String(manifest?.metadata?.name)})`)
      continue
    }
    if (data[name]) problems.push(`${name} twice`)
    if (manifest.metadata?.namespace !== NAMESPACE) problems.push(`${name} outside the ${NAMESPACE} namespace`)
    if (manifest.type !== "Opaque") problems.push(`${name} not of type Opaque`)
    const fields = (manifest.stringData ?? {}) as Record<string, unknown>
    const strings: Record<string, string> = {}
    for (const [field, value] of Object.entries(fields)) {
      if (typeof value === "string" && value !== "") strings[field] = value
      else problems.push(`${name}.${field} empty or not a string`)
    }
    data[name] = strings
  }
  for (const name of SECRET_NAMES) {
    const fields = data[name]
    if (!fields) {
      problems.push(`no ${name}`)
      continue
    }
    for (const field of REQUIRED[name]) if (!(field in fields)) problems.push(`${name}.${field} missing`)
  }
  for (const pair of PAIRS)
    if (data["id-env"] && pair.filter((field) => field in data["id-env"]!).length === 1) problems.push(`id-env has half of ${pair.join(" and ")}`)
  if (problems.length > 0) throw new SetupError(`${label} does not hold the three Secrets: ${problems.join("; ")}`)
  return data as SecretsData
}

/** A platform application's pair from the environment: both or neither; half a pair is refused. */
function pairFrom(env: Context["env"], [id, secret]: readonly [string, string]): Record<string, string> {
  const values = [env[id]?.trim(), env[secret]?.trim()]
  if (values.every((value) => !value)) return {}
  if (!values.every(Boolean)) throw new UsageError(`${id} and ${secret} go together: set both or neither`)
  return { [id]: values[0]!, [secret]: values[1]! }
}

function certManagerToken(env: Context["env"]): string {
  const token = requireVariable(env, "CERT_MANAGER_CLOUDFLARE_TOKEN", "cert-manager's Cloudflare token, with Zone > DNS > Edit on the zone only")
  if (token === env.CLOUDFLARE_API_TOKEN?.trim())
    throw new UsageError("CERT_MANAGER_CLOUDFLARE_TOKEN is Terraform's token: cert-manager gets its own, with Zone > DNS > Edit only")
  return token
}

async function adminUrl(context: Context, paths: Paths): Promise<string> {
  const url = (await readOutput(context, paths.envDir, "database_admin_url", stateEnv(context.env))).trim()
  if (!/^postgres(ql)?:\/\//.test(url) || !url.includes("sslmode=verify-full"))
    throw new SetupError("Terraform's database_admin_url is not a postgres:// URL with sslmode=verify-full")
  return url
}

/** What `init-secrets` does. */
export type InitSecretsOptions = {
  environment: EnvironmentName
  paths: Paths
  /** Replace an existing file with a fresh one: every random value changes. */
  force?: boolean
  /** Replace one value of the existing file instead. */
  rotate?: string
}

async function writeVerified(context: Context, paths: Paths, data: SecretsData): Promise<void> {
  const encrypted = await encrypt(context, paths, formatSecrets(data))
  await writeFile(paths.secretsFile, encrypted)
  const label = shown(paths, paths.secretsFile)
  const decrypted = parseSecrets(await decrypt(context, paths), label)
  if (JSON.stringify(decrypted) !== JSON.stringify(data))
    throw new SetupError(`${label} does not decrypt to what was written; do not commit it`)
  context.out(`Verified: ${label} decrypts to the three Secrets:\n`)
  for (const name of SECRET_NAMES) context.out(`  ${name}: ${Object.keys(decrypted[name]).join(", ")}\n`)
}

async function rotate(options: InitSecretsOptions, context: Context, field: string): Promise<void> {
  const { paths } = options
  if (field === "BETTER_AUTH_SECRET")
    throw new UsageError(
      "BETTER_AUTH_SECRET encrypts ID's stored signing keys: replacing it makes them unreadable. Rotate it through " +
        "BETTER_AUTH_SECRETS, the versioned ring (apps/id/README.md)",
    )
  if (!ROTATABLE.some((name) => name === field))
    throw new UsageError(`--rotate takes one of ${ROTATABLE.join(", ")}`)
  const label = shown(paths, paths.secretsFile)
  if (!(await exists(paths.secretsFile))) throw new SetupError(`${label} does not exist: run init-secrets without --rotate first`)
  const data = parseSecrets(await decrypt(context, paths), label)
  const idEnv = data["id-env"]
  const pair = PAIRS.find((candidate) => candidate.some((name) => name === field))
  if (field === "ROOT_ADMIN_SECRET") idEnv.ROOT_ADMIN_SECRET = secret48()
  else if (field === "UPSTREAM_TOKEN_SECRETS") {
    let ring: { version: number; value: string }[]
    try {
      ring = JSON.parse(idEnv.UPSTREAM_TOKEN_SECRETS!) as { version: number; value: string }[]
      if (!Array.isArray(ring) || !ring.every((entry) => Number.isInteger(entry.version))) throw new Error()
    } catch {
      throw new SetupError("id-env.UPSTREAM_TOKEN_SECRETS is not a list of versioned keys")
    }
    // The new key encrypts from now on; the previous ones stay so that tokens they encrypted remain readable.
    idEnv.UPSTREAM_TOKEN_SECRETS = JSON.stringify([upstreamKey(Math.max(0, ...ring.map((entry) => entry.version)) + 1), ...ring])
  } else if (field === "OPS_DATABASE_ADMIN_URL") data["postgres-admin"].OPS_DATABASE_ADMIN_URL = await adminUrl(context, paths)
  else if (field === "api-token") data["cloudflare-api-token"]["api-token"] = certManagerToken(context.env)
  else {
    const values = pairFrom(context.env, pair!)
    if (Object.keys(values).length === 0) throw new UsageError(`${pair!.join(" and ")} are not set`)
    Object.assign(idEnv, values)
  }
  await writeVerified(context, paths, data)
  context.out(`\nReplaced ${pair ? pair.join(" and ") : field} in ${label}. Next: commit it; the next deploy applies it.\n`)
}

/**
 * Write the environment's encrypted Secrets: build the three Secrets in memory from random values, Terraform's
 * `database_admin_url`, cert-manager's token and the platform applications' pairs, encrypt them with `sops` under
 * the environment's creation rule, write the file and check that it decrypts to exactly that. With `rotate`, replace
 * one value of the existing file instead.
 */
export async function initSecrets(options: InitSecretsOptions, context: Context): Promise<void> {
  if (options.rotate !== undefined) return rotate(options, context, options.rotate)
  const { paths } = options
  const label = shown(paths, paths.secretsFile)
  if ((await exists(paths.secretsFile)) && !options.force)
    throw new SetupError(`${label} exists. --rotate <key> replaces one value; --force replaces them all`)
  const idEnv = {
    BETTER_AUTH_SECRET: secret48(),
    UPSTREAM_TOKEN_SECRETS: JSON.stringify([upstreamKey(1)]),
    ROOT_ADMIN_SECRET: secret48(),
    ...pairFrom(context.env, PAIRS[0]),
    ...pairFrom(context.env, PAIRS[1]),
  }
  const apiToken = certManagerToken(context.env)
  const data: SecretsData = {
    "id-env": idEnv,
    "postgres-admin": { OPS_DATABASE_ADMIN_URL: await adminUrl(context, paths) },
    "cloudflare-api-token": { "api-token": apiToken },
  }
  await writeVerified(context, paths, data)
  const missing = PAIRS.filter(([id]) => !(id in idEnv))
  context.out(`\nWrote ${label}.\n`)
  for (const [id, secret] of missing)
    context.out(`No ${id} yet: set ${id} and ${secret}, then run init-secrets --rotate ${secret} to add it.\n`)
  context.out(`Next: commit ${label}; the deploy applies it before the release. ROOT_ADMIN_SECRET is the first-run bearer,
which id-first-run reads from this file when ID is up.
`)
}

/** The root secret, read from the environment's Secrets file into memory. */
export async function readRootSecret(context: Context, paths: Paths): Promise<string> {
  const label = shown(paths, paths.secretsFile)
  if (!(await exists(paths.secretsFile))) throw new SetupError(`${label} does not exist: run init-secrets first`)
  return parseSecrets(await decrypt(context, paths), label)["id-env"].ROOT_ADMIN_SECRET!
}

/** For `publish-env`: the `age` private key from the key file, without its comments. */
export async function readAgeKey(paths: Paths): Promise<string> {
  const label = shown(paths, paths.keyFile)
  if (!(await exists(paths.keyFile))) throw new SetupError(`${label} does not exist: run age-init first`)
  const line = (await readFile(paths.keyFile, "utf8")).split("\n").find((text) => text.startsWith("AGE-SECRET-KEY-"))
  if (!line) throw new SetupError(`${label} holds no AGE-SECRET-KEY line`)
  return line.trim()
}
