import { X509Certificate } from "node:crypto"
import { isIP } from "node:net"
import { writeFile } from "node:fs/promises"
import { formatFacts, isSelfSigned, pemBlocks } from "./certificates"
import { exists, type Context } from "./context"
import { shown, type EnvironmentName, type Paths } from "./environments"
import { SetupError } from "./errors"
import { requireOpenSsl3 } from "./origin-pull"
import { commandLine } from "./run"
import { readOutput, stateEnv } from "./terraform"

/** The image the printed `kubectl run` uses: Alpine, pinned by digest, which installs openssl when it starts. */
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
}

/** What the pod runs: install openssl, then print the chain the database presents. */
export function fetchScript(host: string, port: string): string {
  return `apk add --no-cache --quiet openssl >/dev/null && openssl s_client -starttls postgres -connect ${host}:${port} -showcerts </dev/null`
}

/** The command an operator runs to fetch the chain from inside the cluster, piped into `--from-stdin`. */
export function podCommand(environment: EnvironmentName, host: string, port: string): string {
  return [
    `kubectl --kubeconfig admin.kubeconfig run database-ca --namespace default --rm -i --restart=Never --quiet \\`,
    `    --image=${FETCH_IMAGE} -- \\`,
    `    sh -c '${fetchScript(host, port)}' \\`,
    `    | bun run setup database-ca --environment ${environment} --from-stdin`,
  ].join("\n")
}

function names(certificate: X509Certificate): string {
  return certificate.subjectAltName ?? `no subject alternative names (subject ${certificate.subject.split("\n").join(", ")})`
}

function covers(certificate: X509Certificate, host: string): boolean {
  return Boolean(isIP(host) ? certificate.checkIP(host) : certificate.checkHost(host))
}

/**
 * Record the database's CA certificate, trust-on-first-use: connect with `openssl s_client -starttls postgres` (or read
 * what a pod fetched, with `--from-stdin`), keep the self-signed root of the presented chain, or the topmost
 * certificate when no root is presented, write it to `database-ca.pem` and print what the operator must record.
 */
export async function databaseCa(options: DatabaseCaOptions, context: Context): Promise<void> {
  const { paths, environment } = options
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
      context.out(`
The database at ${host}:${port} did not present a certificate to this machine (exit ${result.exitCode}${
        result.stderr.trim() ? `: ${result.stderr.trim().split("\n").at(-1)}` : ""
      }).
It sits on the environment's private network, so fetch its chain from a pod in the cluster instead. With the cluster's
admin kubeconfig in admin.kubeconfig (civo kubernetes config answerable-${environment}-cluster > admin.kubeconfig, or
the Civo dashboard's download), run from the repository root:

${podCommand(environment, host, port)}
`)
      throw new SetupError(`no certificate from ${host}:${port}; run the command above`)
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
