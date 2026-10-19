import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { X509Certificate } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { connect, createServer, type Server, type Socket } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer as createTlsServer } from "node:tls"
import { certificatesIn, clientHello, databaseAuthority, fetchPresentedChain } from "./database-ca"
import { INTERMEDIATE, LEAF, ROOT } from "./test-certificates"
import { fakeFetchChain, fakeKubernetes } from "./testing"

const der = (pem: string) => Buffer.from(new X509Certificate(pem).raw)
const u16 = (value: number) => Buffer.from([value >> 8, value & 0xff])
const u24 = (value: number) => Buffer.from([value >> 16, (value >> 8) & 0xff, value & 0xff])
/** A TLS record of `type` carrying `body`. */
const record = (type: number, body: Buffer) => Buffer.concat([Buffer.from([type, 3, 3]), u16(body.length), body])
/** A handshake message of `type`. */
const message = (type: number, body: Buffer) => Buffer.concat([Buffer.from([type]), u24(body.length), body])
const serverHello = message(2, Buffer.alloc(70, 1))
const certificateMessage = (certificates: Buffer[]) => {
  const list = Buffer.concat(certificates.map(certificate => Buffer.concat([u24(certificate.length), certificate])))
  return message(11, Buffer.concat([u24(list.length), list]))
}
const chain = [der(LEAF), der(INTERMEDIATE), der(ROOT)]
/** What a TLS 1.2 server sends first: its hello and its certificates, in one handshake record. */
const flight = record(22, Buffer.concat([serverHello, certificateMessage(chain)]))

describe("certificatesIn", () => {
  test("reads the certificates of the Certificate message after the ServerHello, leaf first", () => {
    expect(certificatesIn(flight)).toEqual(chain)
  })

  test("waits for more while a record or the Certificate message is incomplete, or only the hello has come", () => {
    expect(certificatesIn(flight.subarray(0, 3))).toBeUndefined()
    expect(certificatesIn(flight.subarray(0, flight.length - 1))).toBeUndefined()
    expect(certificatesIn(record(22, serverHello))).toBeUndefined()
    // The Certificate message split across two records.
    const handshake = Buffer.concat([serverHello, certificateMessage(chain)])
    const split = Buffer.concat([record(22, handshake.subarray(0, 100)), record(22, handshake.subarray(100))])
    expect(certificatesIn(split.subarray(0, 120))).toBeUndefined()
    expect(certificatesIn(split)).toEqual(chain)
  })

  test("an alert, another record, another message first or no certificate is an error", () => {
    expect(() => certificatesIn(record(21, Buffer.from([2, 70])))).toThrow("refused the TLS 1.2 handshake with alert 70")
    expect(() => certificatesIn(record(23, Buffer.alloc(4)))).toThrow("sent a TLS record of type 23 before its certificate")
    expect(() => certificatesIn(record(22, Buffer.concat([serverHello, message(14, Buffer.alloc(0))])))).toThrow("presented no certificate (TLS handshake message 14 came before one)")
    expect(() => certificatesIn(record(22, certificateMessage([])))).toThrow("presented no certificate (an empty Certificate message)")
  })
})

describe("clientHello", () => {
  test("is a TLS 1.2 ClientHello record naming the server, and names no address", () => {
    const hello = clientHello("db.example")
    expect([...hello.subarray(0, 3)]).toEqual([0x16, 3, 1])
    expect(hello.readUInt16BE(3)).toBe(hello.length - 5)
    expect(hello[5]).toBe(1)
    expect(hello.readUInt16BE(9)).toBe(0x0303)
    expect(hello.includes(Buffer.from("db.example"))).toBe(true)
    // No supported_versions extension (43): the server answers in TLS 1.2, whose certificates travel in the clear.
    expect(hello.includes(Buffer.from([0, 43]))).toBe(false)
    expect(clientHello("10.10.0.5").length).toBeLessThan(hello.length - "db.example".length)
  })
})

/** A TCP server that hands each connection to `serve`; closed after the test file. */
const servers: Server[] = []
afterAll(() => {
  for (const server of servers) server.close()
})
async function listen(serve: (socket: Socket) => void) {
  const server = createServer(socket => {
    socket.on("error", () => {})
    serve(socket)
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  return (server.address() as { port: number }).port
}
/** A database that reads the SSLRequest, records it, answers `answer`, and then does `then` with the socket. */
async function database(answer: string, then: (socket: Socket, received: Buffer[]) => void = () => {}) {
  const received: Buffer[] = []
  const port = await listen(socket =>
    socket.once("data", request => {
      received.push(request)
      socket.write(answer)
      if (answer === "S") socket.once("data", hello => (received.push(hello), then(socket, received)))
      else then(socket, received)
    }),
  )
  return { port, received }
}

describe("fetchPresentedChain", () => {
  test("sends PostgreSQL's SSLRequest, then a ClientHello once the database answers S, and reads the certificates it presents", async () => {
    const db = await database("S", socket => {
      // In pieces, as a network may deliver it.
      socket.write(flight.subarray(0, 50))
      setTimeout(() => socket.write(flight.subarray(50)), 10)
    })
    expect(await fetchPresentedChain("127.0.0.1", db.port)).toEqual(chain)
    expect([...db.received[0]!]).toEqual([0, 0, 0, 8, 0x04, 0xd2, 0x16, 0x2f])
    expect(db.received[1]![0]).toBe(0x16)
  })

  test("a database that answers N serves no TLS: the error says so, and that Civo's serves none", async () => {
    const { port } = await database("N")
    await expect(fetchPresentedChain("127.0.0.1", port)).rejects.toThrow(`The database at 127.0.0.1:${port} refused TLS: it answered N to PostgreSQL's SSLRequest. Civo's database serves no TLS`)
  })

  test("any other answer, an alert, a hang-up, silence and no listener are errors naming the database", async () => {
    const other = await database("E")
    await expect(fetchPresentedChain("127.0.0.1", other.port)).rejects.toThrow(`The database at 127.0.0.1:${other.port} answered PostgreSQL's SSLRequest with neither S nor N`)
    const alert = await database("S", socket => socket.write(record(21, Buffer.from([2, 40]))))
    await expect(fetchPresentedChain("127.0.0.1", alert.port)).rejects.toThrow(`The database at 127.0.0.1:${alert.port} refused the TLS 1.2 handshake with alert 40`)
    const hangUp = await database("S", socket => socket.end())
    await expect(fetchPresentedChain("127.0.0.1", hangUp.port)).rejects.toThrow(`The database at 127.0.0.1:${hangUp.port} hung up before it presented a certificate`)
    const silent = await listen(() => {})
    await expect(fetchPresentedChain("127.0.0.1", silent, { timeoutMs: 50 })).rejects.toThrow(`The database at 127.0.0.1:${silent} did not answer within 0.05 s: can this pod reach it (networkPolicy.database)?`)
    const closed = await listen(() => {})
    servers.at(-1)!.close()
    await expect(fetchPresentedChain("::1", closed)).rejects.toThrow(`Could not reach the database at [::1]:${closed}`)
  })

  describe("against a real TLS server", () => {
    // A certificate authority and a server certificate made with openssl, as the kind stack makes its database's.
    const directory = mkdtempSync(join(tmpdir(), "infra-ops-tls-"))
    const file = (name: string) => join(directory, name)
    const openssl = (...args: string[]) => {
      const result = Bun.spawnSync(["openssl", ...args], { cwd: directory, stdout: "pipe", stderr: "pipe" })
      if (result.exitCode !== 0) throw new Error(`openssl ${args[0]} exited with ${result.exitCode}: ${result.stderr.toString()}`)
    }
    let port = 0
    beforeAll(async () => {
      const config = (cn: string, extensions: string) => `[req]\ndistinguished_name = dn\nprompt = no\n[dn]\nCN = ${cn}\n[extensions]\n${extensions}\n`
      writeFileSync(file("ca.cnf"), config("Ops test CA", "basicConstraints = critical,CA:TRUE\nkeyUsage = critical,keyCertSign,cRLSign\nsubjectKeyIdentifier = hash"))
      writeFileSync(file("server.cnf"), config("localhost", "basicConstraints = critical,CA:FALSE\nkeyUsage = critical,digitalSignature\nextendedKeyUsage = serverAuth\nsubjectAltName = DNS:localhost,IP:127.0.0.1"))
      openssl("ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", "ca.key")
      openssl("req", "-new", "-x509", "-key", "ca.key", "-config", "ca.cnf", "-extensions", "extensions", "-days", "2", "-out", "ca.pem")
      openssl("ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", "server.key")
      openssl("req", "-new", "-key", "server.key", "-config", "server.cnf", "-out", "server.csr")
      openssl("x509", "-req", "-in", "server.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-set_serial", "0x1d3a", "-days", "2", "-extfile", "server.cnf", "-extensions", "extensions", "-out", "server.pem")
      const tls = createTlsServer({ key: readFileSync(file("server.key")), cert: readFileSync(file("server.pem"), "utf8") + readFileSync(file("ca.pem"), "utf8") }, socket => socket.on("error", () => {}))
      tls.on("tlsClientError", () => {})
      servers.push(tls as unknown as Server)
      await new Promise<void>(resolve => tls.listen(0, "127.0.0.1", resolve))
      const tlsPort = (tls.address() as { port: number }).port
      // PostgreSQL's front door: the SSLRequest answered with S, then the bytes passed to the TLS server and back.
      port = await listen(socket =>
        socket.once("data", () => {
          const upstream = connect({ host: "127.0.0.1", port: tlsPort }, () => socket.write("S"))
          upstream.on("error", () => socket.destroy())
          socket.pipe(upstream).pipe(socket)
        }),
      )
    })
    afterAll(() => rmSync(directory, { recursive: true, force: true }))

    test("reads the server's certificate and the authority it presents with it", async () => {
      const presented = (await fetchPresentedChain("localhost", port)).map(certificate => new X509Certificate(certificate))
      expect(presented.map(certificate => certificate.subject)).toEqual(["CN=localhost", "CN=Ops test CA"])
      expect(presented[1]!.toString()).toBe(new X509Certificate(readFileSync(file("ca.pem"))).toString())
    })
  })
})

describe("databaseAuthority", () => {
  const run = (kube: ReturnType<typeof fakeKubernetes>, presented: string[], host = "db.example") => {
    const fetch = fakeFetchChain(presented)
    const lines: string[] = []
    const result = databaseAuthority({ kube: kube.client, fetchChain: fetch.fetchChain, host, port: 5432, log: line => lines.push(line) })
    return { result, fetch, printed: () => lines.join("\n") }
  }

  test("on first use, fetches the chain, keeps its self-signed root in the ConfigMap postgres-ca and logs what to record", async () => {
    const kube = fakeKubernetes()
    const { result, fetch, printed } = run(kube, [LEAF, INTERMEDIATE, ROOT])
    expect(await result).toBe(ROOT)
    expect(kube.configMaps).toEqual({ "postgres-ca": { "ca.pem": ROOT } })
    expect(fetch.calls).toEqual(["db.example:5432"])
    const root = new X509Certificate(ROOT)
    for (const line of [
      "The database at db.example:5432 presented 3 certificates:",
      "  1. CN=db.example, issued by CN=Test Intermediate CA",
      "Wrote the ConfigMap postgres-ca (ca.pem): the self-signed root.",
      "  Subject:  CN=Test Root CA",
      "  Valid:    2026-10-13T13:32:54.000Z to 2126-09-19T13:32:54.000Z",
      `  SHA-256:  ${root.fingerprint256}`,
      "The database's certificate names: DNS:db.example, IP Address:10.10.0.5.",
      "They cover db.example, the host of OPS_DATABASE_ADMIN_URL.",
      "This is trust on first use",
    ]) expect(printed()).toContain(line)
    expect(printed()).not.toContain("Warning")
  })

  test("without a root it keeps the topmost certificate and warns; names that do not cover the host are a warning too", async () => {
    const topmost = run(fakeKubernetes(), [LEAF, INTERMEDIATE], "10.10.0.5")
    expect(await topmost.result).toBe(INTERMEDIATE)
    expect(topmost.printed()).toContain("the topmost certificate, since no self-signed root was presented")
    expect(topmost.printed()).toContain("Warning: it is not a root, and verify-full needs the root of the chain")
    expect(topmost.printed()).toContain("They cover 10.10.0.5")
    const leafOnly = run(fakeKubernetes(), [LEAF], "db.other.example")
    expect(await leafOnly.result).toBe(LEAF)
    expect(leafOnly.printed()).toContain("presented 1 certificate:")
    expect(leafOnly.printed()).toContain("Warning: it is not a CA certificate")
    expect(leafOnly.printed()).toContain("Warning: they do not cover db.other.example, the host of OPS_DATABASE_ADMIN_URL, so verify-full will refuse it")
    const selfSigned = run(fakeKubernetes(), [ROOT])
    expect(await selfSigned.result).toBe(ROOT)
    expect(selfSigned.printed()).toContain("The database's certificate names: no subject alternative names (subject CN=Test Root CA).")
  })

  test("a ConfigMap that holds the authority is used as it is: no fetch, its facts logged", async () => {
    const kube = fakeKubernetes({ configMaps: { "postgres-ca": { "ca.pem": ROOT } } })
    const { result, fetch, printed } = run(kube, [LEAF])
    expect(await result).toBe(ROOT)
    expect(fetch.calls).toEqual([])
    expect(printed()).toContain("The ConfigMap postgres-ca holds the database's certificate authority; db.example:5432 is verified against it:")
    expect(printed()).toContain(`SHA-256:  ${new X509Certificate(ROOT).fingerprint256}`)
  })

  test("a ConfigMap whose ca.pem is not a certificate is an error saying how to fetch it again", async () => {
    const { result } = run(fakeKubernetes({ configMaps: { "postgres-ca": { "ca.pem": "not a certificate" } } }), [LEAF])
    await expect(result).rejects.toThrow("The ConfigMap postgres-ca holds no PEM certificate in ca.pem: delete it, and bootstrap fetches the database's certificate again")
  })
})
