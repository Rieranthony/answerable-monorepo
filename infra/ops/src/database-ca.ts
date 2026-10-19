import { X509Certificate } from "node:crypto"
import { connect, isIP } from "node:net"
import type { Kubernetes } from "./kubernetes"

/** The ConfigMap, and its key, that hold the database's certificate authority: every pod mounts it at /etc/ssl/db/ca.pem. */
const CA_CONFIGMAP = "postgres-ca"
const CA_KEY = "ca.pem"

/** The certificates a database presents, leaf first, as DER. */
export type FetchChain = (host: string, port: number) => Promise<Buffer[]>

// PostgreSQL's SSLRequest: an int32 length of 8, then the int32 code 80877103. The server answers one byte, S or N.
const SSL_REQUEST = Buffer.from([0, 0, 0, 8, 0x04, 0xd2, 0x16, 0x2f])

const u16 = (value: number) => Buffer.from([value >> 8, value & 0xff])
const u24 = (value: number) => Buffer.from([value >> 16, (value >> 8) & 0xff, value & 0xff])
const vector = (...parts: Buffer[]) => {
  const body = Buffer.concat(parts)
  return Buffer.concat([u16(body.length), body])
}
const extension = (type: number, body: Buffer) => Buffer.concat([u16(type), vector(body)])

/**
 * A TLS 1.2 ClientHello. In TLS 1.2 the server's Certificate message travels in the clear, so the fetch reads every
 * certificate the database presents and hangs up before any key is agreed: Bun's TLS client exposes the leaf alone. It
 * offers the ECDHE and RSA AES-GCM and ChaCha20 suites a PostgreSQL server enables by default, with the server's name
 * when it is not an address.
 */
export function clientHello(host: string) {
  const suites = [0xc02b, 0xc02f, 0xc02c, 0xc030, 0xcca9, 0xcca8, 0x009c, 0x009d]
  const extensions = [
    ...(isIP(host) ? [] : [extension(0x0000, vector(Buffer.from([0]), vector(Buffer.from(host))))]),
    // x25519, P-256 and P-384; uncompressed points; ECDSA, RSA-PSS and RSA signatures with SHA-256, -384 and -512.
    extension(0x000a, vector(...[0x001d, 0x0017, 0x0018].map(u16))),
    extension(0x000b, Buffer.from([1, 0])),
    extension(0x000d, vector(...[0x0403, 0x0804, 0x0401, 0x0503, 0x0805, 0x0501, 0x0806, 0x0601].map(u16))),
  ]
  const body = Buffer.concat([u16(0x0303), Buffer.from(crypto.getRandomValues(new Uint8Array(32))), Buffer.from([0]), vector(...suites.map(u16)), Buffer.from([1, 0]), vector(...extensions)])
  const handshake = Buffer.concat([Buffer.from([1]), u24(body.length), body])
  return Buffer.concat([Buffer.from([0x16, 3, 1]), u16(handshake.length), handshake])
}

/**
 * The certificates in what the server sent after its S: its TLS records, whose handshake messages are a ServerHello and
 * then the Certificate message. Undefined while the Certificate message is incomplete; an error for an alert, for any
 * other record, and for a server that presents no certificate.
 */
export function certificatesIn(flight: Buffer): Buffer[] | undefined {
  let handshake = Buffer.alloc(0)
  for (let at = 0; at + 5 <= flight.length; ) {
    const type = flight[at]!
    const end = at + 5 + flight.readUInt16BE(at + 3)
    if (end > flight.length) break
    const fragment = flight.subarray(at + 5, end)
    at = end
    if (type === 21) throw new Error(`refused the TLS 1.2 handshake with alert ${fragment[1]}, which the fetch needs to read its certificates`)
    if (type !== 22) throw new Error(`sent a TLS record of type ${type} before its certificate`)
    handshake = Buffer.concat([handshake, fragment])
  }
  for (let at = 0; at + 4 <= handshake.length; ) {
    const type = handshake[at]!
    const end = at + 4 + handshake.readUIntBE(at + 1, 3)
    if (end > handshake.length) return undefined
    const message = handshake.subarray(at + 4, end)
    at = end
    if (type === 2) continue
    if (type !== 11) throw new Error(`presented no certificate (TLS handshake message ${type} came before one)`)
    const certificates: Buffer[] = []
    for (let next = 3; next + 3 <= message.length; ) {
      const length = message.readUIntBE(next, 3)
      certificates.push(Buffer.from(message.subarray(next + 3, next + 3 + length)))
      next += 3 + length
    }
    if (certificates.length === 0) throw new Error("presented no certificate (an empty Certificate message)")
    return certificates
  }
  return undefined
}

const show = (host: string, port: number) => `${host.includes(":") ? `[${host}]` : host}:${port}`

/**
 * Ask the database at `host`:`port` for TLS with PostgreSQL's SSLRequest and read the certificates it presents, leaf
 * first, without verifying them: this is the fetch, trust on first use. Fails naming the database when it refuses TLS
 * (it answers N), answers anything else, cannot be reached, hangs up, or says nothing within `timeoutMs`.
 */
export function fetchPresentedChain(host: string, port: number, { timeoutMs = 15_000 }: { timeoutMs?: number } = {}): Promise<Buffer[]> {
  const address = show(host, port)
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port })
    let answered = false
    let flight = Buffer.alloc(0)
    const finish = (error: Error | undefined, certificates?: Buffer[]) => {
      clearTimeout(timer)
      socket.destroy()
      if (error) reject(error)
      else resolve(certificates!)
    }
    const timer = setTimeout(() => finish(new Error(`The database at ${address} did not answer within ${timeoutMs / 1000} s: can this pod reach it (networkPolicy.database)?`)), timeoutMs)
    socket.on("connect", () => socket.write(SSL_REQUEST))
    socket.on("data", (chunk: Buffer) => {
      let data = chunk
      if (!answered) {
        answered = true
        if (data[0] === 0x4e)
          return finish(new Error(`The database at ${address} refused TLS: it answered N to PostgreSQL's SSLRequest. Civo's database serves no TLS, so no login can verify it (sslmode=verify-full); nothing was written`))
        if (data[0] !== 0x53) return finish(new Error(`The database at ${address} answered PostgreSQL's SSLRequest with neither S nor N: is it PostgreSQL?`))
        socket.write(clientHello(host))
        data = data.subarray(1)
      }
      flight = Buffer.concat([flight, data])
      try {
        const certificates = certificatesIn(flight)
        if (certificates) finish(undefined, certificates)
      } catch (error) {
        finish(new Error(`The database at ${address} ${(error as Error).message}`))
      }
    })
    socket.on("error", (error: Error) => finish(new Error(`Could not reach the database at ${address}: ${error.message}`)))
    socket.on("close", () => finish(new Error(`The database at ${address} hung up before it presented a certificate`)))
  })
}

const oneLine = (name: string) => name.split("\n").filter(Boolean).join(", ")

/** What an operator records about a certificate: names, validity and fingerprint, one fact a line. */
function facts(certificate: X509Certificate) {
  return [
    `  Subject:  ${oneLine(certificate.subject)}`,
    `  Issuer:   ${oneLine(certificate.issuer)}`,
    `  Valid:    ${new Date(certificate.validFrom).toISOString()} to ${new Date(certificate.validTo).toISOString()}`,
    `  SHA-256:  ${certificate.fingerprint256}`,
  ]
}

const selfSigned = (certificate: X509Certificate) => Boolean(certificate.checkIssued(certificate)) && certificate.verify(certificate.publicKey)

type AuthorityOptions = {
  kube: Kubernetes
  fetchChain: FetchChain
  /** The database's host and port, from the administrative URL: what the services' URLs name and verify-full checks. */
  host: string
  port: number
  log: (line: string) => void
}

/**
 * The database's certificate authority, PEM. The ConfigMap postgres-ca's when it exists; otherwise fetched from the
 * database (trust on first use): the self-signed root of the chain it presents, or the topmost certificate when it
 * presents no root, written to the ConfigMap. Either way it logs the certificate's subject, issuer, validity and SHA-256
 * fingerprint; on a fetch also the names the database's own certificate carries and whether they cover `host`.
 */
export async function databaseAuthority({ kube, fetchChain, host, port, log }: AuthorityOptions): Promise<string> {
  const address = show(host, port)
  const stored = (await kube.readConfigMap(CA_CONFIGMAP))?.[CA_KEY]
  if (stored) {
    let certificate: X509Certificate
    try {
      certificate = new X509Certificate(stored)
    } catch {
      throw new Error(`The ConfigMap ${CA_CONFIGMAP} holds no PEM certificate in ${CA_KEY}: delete it, and bootstrap fetches the database's certificate again`)
    }
    log([`The ConfigMap ${CA_CONFIGMAP} holds the database's certificate authority; ${address} is verified against it:`, ...facts(certificate)].join("\n"))
    return stored
  }
  const chain = (await fetchChain(host, port)).map(der => new X509Certificate(der))
  const rootAt = chain.findIndex(selfSigned)
  const kept = chain[rootAt >= 0 ? rootAt : chain.length - 1]!
  const pem = kept.toString()
  await kube.writeConfigMap(CA_CONFIGMAP, { [CA_KEY]: pem })
  const leaf = chain[0]!
  const covered = isIP(host) ? leaf.checkIP(host) : leaf.checkHost(host)
  log([
    `The database at ${address} presented ${chain.length} certificate${chain.length === 1 ? "" : "s"}:`,
    ...chain.map((certificate, at) => `  ${at + 1}. ${oneLine(certificate.subject)}, issued by ${oneLine(certificate.issuer)}`),
    `Wrote the ConfigMap ${CA_CONFIGMAP} (${CA_KEY}): ${rootAt >= 0 ? "the self-signed root" : "the topmost certificate, since no self-signed root was presented"}.`,
    ...facts(kept),
    ...(rootAt >= 0 && kept.ca ? [] : [`Warning: it is ${kept.ca ? "not a root" : "not a CA certificate"}, and verify-full needs the root of the chain: put the database's CA certificate in the ConfigMap ${CA_CONFIGMAP} instead.`]),
    `The database's certificate names: ${leaf.subjectAltName ?? `no subject alternative names (subject ${oneLine(leaf.subject)})`}.`,
    covered ? `They cover ${host}, the host of OPS_DATABASE_ADMIN_URL.` : `Warning: they do not cover ${host}, the host of OPS_DATABASE_ADMIN_URL, so verify-full will refuse it.`,
    `This is trust on first use: the ConfigMap holds whatever answered this connection. Compare the SHA-256 fingerprint with what Civo shows for the database where it shows one. To fetch it again, delete the ConfigMap ${CA_CONFIGMAP} and run bootstrap.`,
  ].join("\n"))
  return pem
}
