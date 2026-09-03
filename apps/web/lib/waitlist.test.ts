import { describe, expect, mock, test } from "bun:test"

import {
  entryUpserted,
  fakeFetch,
  json,
  personUpserted,
  throwing,
} from "./test-helpers"
import { MESSAGES, submitWaitlist } from "./waitlist"

const productionEnv = {
  NODE_ENV: "production",
  ATTIO_API_KEY: "test-key",
  ATTIO_WAITLIST_LIST: "waitlist",
}

function harness(
  responses: Array<() => Response> = [],
  env: Record<string, string | undefined> = productionEnv,
  sleep: (ms: number) => Promise<void> = async () => {},
) {
  const { fetch, calls } = fakeFetch(responses)
  const log = {
    error: mock<(line: string) => void>(() => {}),
    warn: mock<(line: string) => void>(() => {}),
    info: mock<(line: string) => void>(() => {}),
  }
  const submit = (email: string) =>
    submitWaitlist(email, { env, fetch, log, sleep })
  const body = (index: number) => JSON.parse(String(calls[index]?.init.body))
  const lines = (level: keyof typeof log) =>
    log[level].mock.calls.map((call) => String(call[0]))
  const logged = () =>
    [...lines("error"), ...lines("warn"), ...lines("info")].join("\n")
  return { submit, calls, log, body, lines, logged }
}

describe("unit: waitlist", () => {
  test("rejects an empty email without calling Attio", async () => {
    const { submit, calls } = harness()

    expect(await submit("")).toEqual({
      status: "error",
      message: MESSAGES.empty,
    })
    expect(await submit("   ")).toEqual({
      status: "error",
      message: MESSAGES.empty,
    })
    expect(calls).toHaveLength(0)
  })

  test("rejects a malformed email", async () => {
    const { submit, calls } = harness()

    for (const email of [
      "nope",
      "a@b",
      "a b@c.d",
      `${"a".repeat(250)}@b.com`,
    ]) {
      expect(await submit(email)).toEqual({
        status: "error",
        message: MESSAGES.invalid,
      })
    }
    expect(calls).toHaveLength(0)
  })

  test("normalizes case and whitespace before sending", async () => {
    const { submit, body } = harness([personUpserted, entryUpserted])

    expect(await submit("  Foo@Example.COM ")).toEqual({
      status: "success",
      email: "foo@example.com",
    })
    expect(body(0).data.values.email_addresses).toEqual([
      { email_address: "foo@example.com" },
    ])
  })

  test("logs and succeeds without a key outside production", async () => {
    const { submit, calls, log, lines } = harness([], {
      NODE_ENV: "development",
    })

    expect(await submit("a@b.com")).toEqual({
      status: "success",
      email: "a@b.com",
    })
    expect(calls).toHaveLength(0)
    expect(lines("info")).toEqual([
      '[waitlist] attio_not_configured_signup_logged_only {"email":"a@b.com"}',
    ])
    expect(log.error).not.toHaveBeenCalled()
  })

  test("fails loudly without a key in production", async () => {
    const { submit, calls, lines } = harness([], { NODE_ENV: "production" })

    expect(await submit("a@b.com")).toEqual({
      status: "error",
      message: MESSAGES.failed,
    })
    expect(calls).toHaveLength(0)
    expect(lines("error")).toEqual([
      '[waitlist] attio_not_configured {"email":"a@b.com"}',
    ])
  })

  test("upserts the person and the list entry", async () => {
    const { submit, calls, logged } = harness([personUpserted, entryUpserted])

    expect(await submit("a@b.com")).toEqual({
      status: "success",
      email: "a@b.com",
    })
    expect(calls).toHaveLength(2)
    expect(logged()).toBe("")
  })

  test("maps an Attio input rejection to the invalid-email message", async () => {
    const { submit, lines } = harness([
      json(400, { code: "validation_type", message: "invalid email domain" }),
    ])

    expect(await submit("a@b.zz")).toEqual({
      status: "error",
      message: MESSAGES.invalid,
    })
    expect(lines("warn")).toEqual([
      '[waitlist] attio_rejected_email {"email":"a@b.zz","kind":"invalid_input","status":400,"code":"validation_type","message":"invalid email domain"}',
    ])
  })

  test("treats duplicate matches as already known", async () => {
    const { submit, lines } = harness([
      json(409, { code: "MULTIPLE_MATCH_RESULTS", message: "dupes" }),
    ])

    expect(await submit("a@b.com")).toEqual({
      status: "success",
      email: "a@b.com",
    })
    expect(lines("warn")).toHaveLength(1)
    expect(lines("warn")[0]).toStartWith("[waitlist] attio_multiple_matches ")
    expect(lines("warn")[0]).toContain('"kind":"multiple_matches"')
  })

  test("returns the generic error on Attio failure and logs the details", async () => {
    const { submit, lines } = harness([json(500, {}), json(500, {})])

    expect(await submit("a@b.com")).toEqual({
      status: "error",
      message: MESSAGES.failed,
    })
    expect(lines("error")).toEqual([
      '[waitlist] attio_failed {"email":"a@b.com","kind":"server","status":500,"message":"{}"}',
    ])
  })

  test("still succeeds when only the list step fails", async () => {
    const { submit, lines } = harness([
      personUpserted,
      json(404, { code: "not_found", message: "List not found" }),
    ])

    expect(await submit("a@b.com")).toEqual({
      status: "success",
      email: "a@b.com",
    })
    expect(lines("error")).toEqual([
      '[waitlist] attio_list_entry_failed {"email":"a@b.com","kind":"not_found","status":404,"code":"not_found","message":"List not found"}',
    ])
  })

  test("logs failures that are not Attio errors", async () => {
    const { submit, lines } = harness(
      [json(500, {})],
      productionEnv,
      async () => {
        throw new Error("boom")
      },
    )

    expect(await submit("a@b.com")).toEqual({
      status: "error",
      message: MESSAGES.failed,
    })
    expect(lines("error")).toEqual([
      '[waitlist] attio_failed {"email":"a@b.com","message":"boom"}',
    ])
  })

  test("never logs the API key", async () => {
    const { submit, logged } = harness([
      json(401, { message: "Unauthorized" }),
      throwing(new TypeError("fetch failed")),
      throwing(new TypeError("fetch failed")),
    ])

    await submit("a@b.com")
    await submit("a@b.com")

    expect(logged()).toContain('"kind":"auth"')
    expect(logged()).toContain('"kind":"network"')
    expect(logged()).not.toContain("test-key")
  })
})
