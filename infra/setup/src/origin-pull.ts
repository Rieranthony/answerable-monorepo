import { X509Certificate } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { formatFacts, pemBlocks } from "./certificates"
import { exists, requireVariable, type Context } from "./context"
import { shown, zoneFor, type EnvironmentName, type Paths } from "./environments"
import { SetupError, UsageError } from "./errors"

/** Cloudflare's API. */
export const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4"

/** What `origin-pull` does. */
export type OriginPullOptions = {
  environment: EnvironmentName
  paths: Paths
  /** The environment's zone, named again as a check. */
  zone: string
  /** Rotate: `edge-ca/ca.pem` exists already. */
  force?: boolean
  /** How long to wait for Cloudflare to deploy the certificate, in seconds. Default 300. */
  waitSeconds?: number
}

type Envelope<T> = { success?: boolean; errors?: { code?: number; message?: string }[]; result?: T }
type ZoneCertificate = { id: string; status?: string; expires_on?: string }

/** Statuses after which a certificate will never become active. */
const FAILED = new Set(["deployment_timed_out", "deleted", "pending_deletion", "deletion_timed_out"])

function cloudflare(context: Context, token: string) {
  return async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const response = await context.fetch(`${CLOUDFLARE_API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    let envelope: Envelope<T>
    try {
      envelope = (await response.json()) as Envelope<T>
    } catch {
      envelope = {}
    }
    if (!response.ok || envelope.success !== true || envelope.result === undefined) {
      const reasons = (envelope.errors ?? []).map((error) => `${error.code ?? "?"} ${error.message ?? ""}`.trim()).join("; ")
      throw new SetupError(`Cloudflare answered ${response.status} to ${method} ${path}${reasons ? `: ${reasons}` : ""}`)
    }
    return envelope.result
  }
}

async function openssl(context: Context, directory: string, argv: string[], what: string): Promise<string> {
  const result = await context.run(["openssl", ...argv], { cwd: directory })
  if (result.exitCode !== 0) throw new SetupError(`openssl could not ${what} (exit ${result.exitCode}): ${result.stderr.trim()}`)
  return result.stdout
}

/** Refuse LibreSSL (macOS's `/usr/bin/openssl`), which the commands below were not proved with. */
export async function requireOpenSsl3(context: Context): Promise<void> {
  const result = await context.run(["openssl", "version"])
  if (result.exitCode !== 0 || !result.stdout.startsWith("OpenSSL 3"))
    throw new SetupError(
      `these commands need OpenSSL 3, and \`openssl version\` answered "${result.stdout.trim() || result.stderr.trim()}". ` +
        "On macOS: brew install openssl@3 and put it first on PATH",
    )
}

/** A random positive 128-bit serial number, in hexadecimal. */
function serial(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[0] = bytes[0]! & 0x7f
  return `0x${Buffer.from(bytes).toString("hex")}`
}

type Generated = { ca: string; certificate: string; privateKey: string }

/**
 * A fresh origin-pull CA (ECDSA P-256, 10 years) and a client certificate it signs (ECDSA P-256, 5 years, CN
 * `cloudflare-origin-pull.<zone>`), made in `directory`. Answers the CA's certificate and the client's certificate
 * and key, in memory.
 */
async function generate(context: Context, directory: string, zone: string): Promise<Generated> {
  const curve = ["-algorithm", "EC", "-pkeyopt", "ec_paramgen_curve:P-256"]
  await openssl(context, directory, ["genpkey", ...curve, "-out", "ca.key"], "make the CA's key")
  await openssl(
    context,
    directory,
    [
      "req",
      "-x509",
      "-new",
      "-key",
      "ca.key",
      "-sha256",
      "-days",
      "3650",
      "-subj",
      `/CN=Answerable origin-pull CA (${zone})`,
      "-addext",
      "basicConstraints=critical,CA:TRUE,pathlen:0",
      "-addext",
      "keyUsage=critical,keyCertSign,cRLSign",
      "-out",
      "ca.pem",
    ],
    "make the CA's certificate",
  )
  await openssl(context, directory, ["genpkey", ...curve, "-out", "client.key"], "make the client's key")
  await openssl(
    context,
    directory,
    ["req", "-new", "-key", "client.key", "-subj", `/CN=cloudflare-origin-pull.${zone}`, "-out", "client.csr"],
    "make the client's request",
  )
  await writeFile(
    join(directory, "client.ext"),
    "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=clientAuth\n",
  )
  await openssl(
    context,
    directory,
    [
      "x509",
      "-req",
      "-in",
      "client.csr",
      "-CA",
      "ca.pem",
      "-CAkey",
      "ca.key",
      "-set_serial",
      serial(),
      "-days",
      "1825",
      "-sha256",
      "-extfile",
      "client.ext",
      "-out",
      "client.pem",
    ],
    "sign the client's certificate",
  )
  const verified = await openssl(context, directory, ["verify", "-CAfile", "ca.pem", "client.pem"], "verify the client's certificate")
  if (!verified.includes("client.pem: OK"))
    throw new SetupError(`openssl verify did not accept the client's certificate: ${verified.trim()}`)
  const read = (name: string) => readFile(join(directory, name), "utf8")
  return { ca: await read("ca.pem"), certificate: await read("client.pem"), privateKey: await read("client.key") }
}

async function waitUntilActive(
  context: Context,
  call: ReturnType<typeof cloudflare>,
  path: string,
  first: string | undefined,
  waitSeconds: number,
): Promise<boolean> {
  const deadline = context.now() + waitSeconds * 1000
  let status = first
  for (;;) {
    context.out(`Certificate status: ${status ?? "unknown"}\n`)
    if (status === "active") return true
    if (status && FAILED.has(status)) throw new SetupError(`Cloudflare reports the certificate ${status}`)
    if (context.now() >= deadline) return false
    await context.sleep(5000)
    status = (await call<ZoneCertificate>("GET", path)).status
  }
}

/**
 * Make the zone's origin-pull certificate and upload it as its zone-level Authenticated Origin Pulls certificate, then
 * write the CA's public certificate to `edge-ca/ca.pem`, where Terraform hands it to Traefik. The private keys stay in
 * a temporary directory that is deleted afterwards; the client's key goes to Cloudflare and nowhere else.
 *
 * With `--force` it rotates. Cloudflare presents the newest active certificate as soon as it is deployed, so Traefik
 * must trust the new CA first: `ca.pem` holds the new CA and the old one while the operator applies Terraform, then
 * the certificate is uploaded, then `ca.pem` keeps only the new CA for the next apply.
 */
export async function originPull(options: OriginPullOptions, context: Context): Promise<void> {
  const { paths, environment, zone } = options
  if (zone !== zoneFor(environment)) throw new UsageError(`--zone for ${environment} is ${zoneFor(environment)}, not ${zone}`)
  const token = requireVariable(context.env, "CLOUDFLARE_API_TOKEN", `a token with SSL and Certificates Edit on ${zone}`)
  const caShown = shown(paths, paths.edgeCa)
  const previous = (await exists(paths.edgeCa)) ? await readFile(paths.edgeCa, "utf8") : undefined
  if (previous !== undefined && !options.force)
    throw new SetupError(`${caShown} exists. Run again with --force to rotate the zone's origin-pull certificate`)
  const previousCas = pemBlocks(previous ?? "")
  await requireOpenSsl3(context)

  const call = cloudflare(context, token)
  const zones = await call<{ id: string; name: string }[]>("GET", `/zones?name=${encodeURIComponent(zone)}`)
  const zoneId = zones.find((found) => found.name === zone)?.id
  if (!zoneId) throw new SetupError(`CLOUDFLARE_API_TOKEN cannot see the zone ${zone}`)
  const base = `/zones/${zoneId}/origin_tls_client_auth`
  const older = await call<ZoneCertificate[]>("GET", base)

  const directory = await mkdtemp(join(tmpdir(), "answerable-origin-pull-"))
  let uploaded = false
  try {
    const made = await generate(context, directory, zone)
    await mkdir(dirname(paths.edgeCa), { recursive: true })
    if (previousCas.length > 0) {
      await writeFile(paths.edgeCa, [made.ca, ...previousCas].join(""))
      context.out(`
${caShown} now holds the new CA and the old one. Before the upload, apply it, so that Traefik trusts both while
Cloudflare switches to the new certificate:
  cd ${shown(paths, paths.envDir)} && terraform apply
`)
      const answer = await context.ask("Press Enter once the apply has finished (or type no to stop): ")
      if (answer === null || /^\s*no?\s*$/i.test(answer))
        throw new SetupError(`Stopped before the upload. ${caShown} is back as it was; apply again if you applied the new one`)
    }

    context.out(`Uploading the client certificate to ${zone}.\n`)
    const result = await call<ZoneCertificate>("POST", base, { certificate: made.certificate, private_key: made.privateKey })
    uploaded = true
    const active = await waitUntilActive(context, call, `${base}/${result.id}`, result.status, options.waitSeconds ?? 300)
    await writeFile(paths.edgeCa, active ? made.ca : [made.ca, ...previousCas].join(""))
    const ca = new X509Certificate(made.ca)
    context.out(`
Uploaded certificate ${result.id} to ${zone} as its zone-level Authenticated Origin Pulls certificate.
Wrote ${caShown}, the CA's public certificate:
${formatFacts(ca)}The private keys existed only in ${directory}, which is deleted now.
`)
    if (!active)
      throw new SetupError(
        `certificate ${result.id} is not active after ${options.waitSeconds ?? 300} s. ${caShown} trusts it already. ` +
          `Check it with: curl -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" ${CLOUDFLARE_API}${base}/${result.id}`,
      )
    if (older.length > 0)
      context.out(`
Cloudflare presents the newest certificate. Delete the older ones on the zone after the next apply:
${older.map((old) => `  curl -X DELETE -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" ${CLOUDFLARE_API}${base}/${old.id}   # ${old.status ?? "?"}, expires ${old.expires_on ?? "?"}\n`).join("")}`)
    context.out(`
Next: commit ${caShown}. ${
      previousCas.length > 0
        ? `Then terraform apply in ${shown(paths, paths.envDir)}, so that Traefik stops trusting the old CA.`
        : "The full apply (first-apply --resume) gives it to Traefik and turns origin pulls on."
    }
`)
  } catch (error) {
    if (!uploaded) {
      if (previous === undefined) await rm(paths.edgeCa, { force: true })
      else await writeFile(paths.edgeCa, previous)
    }
    throw error
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
