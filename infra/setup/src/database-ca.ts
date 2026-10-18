import { X509Certificate } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { isIP } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { formatFacts, isSelfSigned, pemBlocks } from "./certificates"
import { exists, type Context } from "./context"
import { shown, type EnvironmentName, type Paths } from "./environments"
import { SetupError } from "./errors"
import { requireOpenSsl3 } from "./origin-pull"
import { commandLine } from "./run"
import { readOutput, stateEnv, type StateEnv } from "./terraform"

/** The image the `kubectl run` fetch uses: Alpine, pinned by digest, which installs openssl when it starts. */
export const FETCH_IMAGE = "docker.io/library/alpine:3.24.2@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6"

/** What `database-ca` does. */
export type DatabaseCaOptions = {
  environment: EnvironmentName
  paths: Paths
  /** Read the chain from standard input (from a pod) instead of connecting from this machine. */
  fromStdin?: boolean
  /** Replace an existing `database-ca.pem`. */
  force?: boolean
  /** How long to wait for the database from this machine, in milliseconds. Default 15 000. */
  timeoutMs?: number
  /** How long the pod may take, image pull and openssl install included, in milliseconds. Default 180 000. */
  podTimeoutMs?: number
}

/** What the pod runs: install openssl, then print the chain the database presents. */
export function fetchScript(host: string, port: string): string {
  return `apk add --no-cache --quiet openssl >/dev/null && openssl s_client -starttls postgres -connect ${host}:${port} -showcerts </dev/null`
}

/** The command an operator runs to fetch the chain from inside the cluster, piped into `--from-stdin`. */
export function podCommand(environment: EnvironmentName, host: string, port: string): string {
  return [
    `kubectl --kubeconfig admin.kubeconfig run database-ca --namespace default --rm -i --restart=Never --quiet \\`,
    `    --image=${FETCH_IMAGE} --command -- \\`,
    `    sh -c '${fetchScript(host, port)}' \\`,
    `    | bun run setup database-ca --environment ${environment} --from-stdin`,
  ].join("\n")
}

/**
 * Fetch the chain from a pod in the cluster: Terraform's `admin_kubeconfig` goes to a 0600 file in a temporary
 * directory for `kubectl`'s `KUBECONFIG`, and the directory is deleted whatever happens. The pod runs in `default`,
 * where nothing restricts it, and deletes itself.
 */
async function fetchFromPod(options: DatabaseCaOptions, context: Context, state: StateEnv, host: string, port: string): Promise<string> {
  const kubeconfig = await readOutput(context, options.paths.envDir, "admin_kubeconfig", state)
  const directory = await mkdtemp(join(tmpdir(), "answerable-database-ca-"))
  try {
    const file = join(directory, "kubeconfig")
    await writeFile(file, kubeconfig, { mode: 0o600 })
    const pod = `database-ca-${Buffer.from(crypto.getRandomValues(new Uint8Array(3))).toString("hex")}`
    const argv = [
      "kubectl",
      "run",
      pod,
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
      fetchScript(host, port),
    ]
    context.out(`$ ${commandLine(argv)}\n  (KUBECONFIG: Terraform's admin_kubeconfig, in a 0600 temporary file)\n`)
    const result = await context.run(argv, { env: { KUBECONFIG: file }, timeoutMs: options.podTimeoutMs ?? 180_000 })
    if (pemBlocks(result.stdout).length > 0) return result.stdout
    context.out(`
The pod did not fetch a certificate either (exit ${result.exitCode}${lastLine(result.stderr)}). To run it yourself, put the
cluster's admin kubeconfig in admin.kubeconfig, readable by you alone, and delete it afterwards:
  (umask 077 && infra/civo/terraform.sh -chdir=${shown(options.paths, options.paths.envDir)} output -raw admin_kubeconfig) > admin.kubeconfig
then, from the repository root:

${podCommand(options.environment, host, port)}
`)
    throw new SetupError(`no certificate from ${host}:${port}, from this machine or from a pod`)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

function lastLine(stderr: string): string {
  return stderr.trim() ? `: ${stderr.trim().split("\n").at(-1)}` : ""
}

function names(certificate: X509Certificate): string {
  return certificate.subjectAltName ?? `no subject alternative names (subject ${certificate.subject.split("\n").join(", ")})`
}

function covers(certificate: X509Certificate, host: string): boolean {
  return Boolean(isIP(host) ? certificate.checkIP(host) : certificate.checkHost(host))
}

/**
 * Record the database's CA certificate, trust-on-first-use: connect with `openssl s_client -starttls postgres`, from
 * this machine or, when the private network keeps it out, from a pod through Terraform's `admin_kubeconfig` (or read
 * what the operator's own pod fetched, with `--from-stdin`); keep the self-signed root of the presented chain, or the
 * topmost certificate when no root is presented, write it to `database-ca.pem` and print what the operator must record.
 */
export async function databaseCa(options: DatabaseCaOptions, context: Context): Promise<void> {
  const { paths } = options
  const caShown = shown(paths, paths.databaseCa)
  if ((await exists(paths.databaseCa)) && !options.force) throw new SetupError(`${caShown} exists. Run again with --force to replace it`)

  let text: string
  let host: string | undefined
  if (options.fromStdin) {
    text = await context.readStdin()
  } else {
    await requireOpenSsl3(context)
    const state = stateEnv(context.env)
    host = (await readOutput(context, paths.envDir, "database_host", state)).trim()
    const port = (await readOutput(context, paths.envDir, "database_port", state)).trim()
    const argv = ["openssl", "s_client", "-starttls", "postgres", "-connect", `${host}:${port}`, "-showcerts"]
    context.out(`$ ${commandLine(argv)}\n`)
    const result = await context.run(argv, { timeoutMs: options.timeoutMs ?? 15_000 })
    text = result.stdout
    if (pemBlocks(text).length === 0) {
      context.out(
        `The database at ${host}:${port} did not present a certificate to this machine (exit ${result.exitCode}${lastLine(result.stderr)}).\n` +
          "It sits on the environment's private network: fetching its chain from a pod in the cluster instead.\n",
      )
      text = await fetchFromPod(options, context, state, host, port)
    }
  }

  const blocks = pemBlocks(text)
  if (blocks.length === 0)
    throw new SetupError("standard input holds no PEM certificate: pipe in the output of openssl s_client -showcerts")
  let chain: X509Certificate[]
  try {
    chain = blocks.map((block) => new X509Certificate(block))
  } catch (error) {
    throw new SetupError(`a presented certificate cannot be read: ${error instanceof Error ? error.message : String(error)}`)
  }
  const rootIndex = chain.findIndex(isSelfSigned)
  const index = rootIndex >= 0 ? rootIndex : chain.length - 1
  const kept = chain[index]!
  await writeFile(paths.databaseCa, blocks[index]!)

  const leaf = chain[0]!
  const lines = [
    `The database presented ${chain.length} certificate${chain.length === 1 ? "" : "s"}:`,
    ...chain.map(
      (certificate, at) =>
        `  ${at + 1}. ${certificate.subject.split("\n").join(", ")}, issued by ${certificate.issuer.split("\n").join(", ")}`,
    ),
    `Wrote ${caShown}: ${rootIndex >= 0 ? "the self-signed root" : "the topmost certificate, since no self-signed root was presented"}.`,
    formatFacts(kept).trimEnd(),
  ]
  if (rootIndex < 0 || !kept.ca)
    lines.push(
      `Warning: ${kept.ca ? "it is not a root" : "it is not a CA certificate"}. sslmode=verify-full needs the root of the chain as`,
      "sslrootcert: ask Civo for the database's CA certificate and put it in this file instead.",
    )
  lines.push(`The server's certificate names: ${names(leaf)}.`)
  if (host)
    lines.push(
      covers(leaf, host)
        ? `It covers ${host}, the host in database_admin_url.`
        : `Warning: it does not cover ${host}, the host in database_admin_url, so verify-full will refuse it. If it names the database's DNS name, switch the output to database_dns_endpoint (infra/civo/README.md).`,
    )
  else lines.push("Check that these names cover the host in Terraform's database_admin_url output.")
  lines.push(
    "",
    "This is trust on first use: the file holds whatever answered this connection. Compare the SHA-256 fingerprint with",
    "what Civo shows for the database where it shows one, and record it with the date in the deployment's progress log.",
    `Next: commit ${caShown}; the deploy passes it to the application chart as database.caPem.`,
  )
  context.out(`${lines.join("\n")}\n`)
}
