import { X509Certificate } from "node:crypto"

const PEM = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g

/** Every PEM certificate block in a text, in order, each ending with a newline. */
export function pemBlocks(text: string): string[] {
  return (text.match(PEM) ?? []).map((block) => `${block}\n`)
}

/** What an operator records about a certificate: names, validity and fingerprint. */
export type CertificateFacts = { subject: string; issuer: string; validFrom: string; validTo: string; sha256: string }

function oneLine(name: string): string {
  return name.split("\n").filter(Boolean).join(", ")
}

/** Read a certificate's facts. */
export function facts(certificate: X509Certificate): CertificateFacts {
  return {
    subject: oneLine(certificate.subject),
    issuer: oneLine(certificate.issuer),
    validFrom: new Date(certificate.validFrom).toISOString(),
    validTo: new Date(certificate.validTo).toISOString(),
    sha256: certificate.fingerprint256,
  }
}

/** A certificate's facts as indented lines for the terminal. */
export function formatFacts(certificate: X509Certificate, indent = "  "): string {
  const known = facts(certificate)
  return [
    `Subject:     ${known.subject}`,
    `Issuer:      ${known.issuer}`,
    `Valid:       ${known.validFrom} to ${known.validTo}`,
    `SHA-256:     ${known.sha256}`,
  ]
    .map((line) => `${indent}${line}\n`)
    .join("")
}

/** Whether a certificate signed itself: a root. */
export function isSelfSigned(certificate: X509Certificate): boolean {
  return certificate.checkIssued(certificate) && certificate.verify(certificate.publicKey)
}
