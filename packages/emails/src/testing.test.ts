import { expect, test } from "bun:test"
import { renderEmail } from "./render"
import { link, mailbox } from "./fixtures"
import { createMemoryTransport } from "./testing"

const message = (to: string) => ({ to, ...renderEmail(link) })

test("keeps every message it was sent, in order, and answers with an id for each", async () => {
  const transport = createMemoryTransport()
  expect(transport.sent).toEqual([])
  const first = message("a@example.com")
  const second = { to: "b@example.com", ...renderEmail(mailbox) }
  expect(await transport.send(first)).toEqual({
    status: "sent",
    messageId: "memory-1",
  })
  expect(await transport.send(second)).toEqual({
    status: "sent",
    messageId: "memory-2",
  })
  expect(transport.sent).toEqual([first, second])
})

test("can be told to fail, sends nothing then, and sends again when told to stop", async () => {
  const transport = createMemoryTransport()
  transport.failure = {
    status: "failed",
    httpStatus: 422,
    errorCode: 406,
    retried: false,
  }
  expect(await transport.send(message("a@example.com"))).toEqual(
    transport.failure,
  )
  expect(transport.sent).toEqual([])
  transport.failure = undefined
  expect((await transport.send(message("a@example.com"))).status).toBe("sent")
  expect(transport.sent).toHaveLength(1)
})
