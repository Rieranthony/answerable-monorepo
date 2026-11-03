// A transport for other packages' tests: keeps what it was sent, and can be told to fail.
import type { Message, SendResult, Transport } from "./transport"

/** A failed `SendResult`: what a test hands `MemoryTransport.failure`. */
export type SendFailure = Extract<SendResult, { status: "failed" }>

/** `createMemoryTransport`'s transport. */
export type MemoryTransport = Transport & {
  /** Every email it sent, in order. A failed send is not in it. */
  readonly sent: Message[]
  /** While set, every send returns it and sends nothing. Set it to `undefined` to send again. */
  failure: SendFailure | undefined
}

/** A transport that sends nothing and remembers every message in `sent`, each with the message id `memory-<n>`. */
export function createMemoryTransport(): MemoryTransport {
  const sent: Message[] = []
  const transport: MemoryTransport = {
    sent,
    failure: undefined,
    async send(message) {
      if (transport.failure) return transport.failure
      sent.push(message)
      return { status: "sent", messageId: `memory-${sent.length}` }
    },
  }
  return transport
}
