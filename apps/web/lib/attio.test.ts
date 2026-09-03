import { describe, expect, test } from "bun:test"

import { AttioError, createAttioClient, parseAttioConfig } from "./attio"
import {
  entryUpserted,
  fakeFetch,
  json,
  personUpserted,
  throwing,
} from "./test-helpers"

const config = { apiKey: "test-key", listId: "waitlist" }

function harness(
  responses: Array<() => Response>,
  overrides: Partial<typeof config> = {},
) {
  const sleeps: number[] = []
  const { fetch, calls } = fakeFetch(responses)
  const client = createAttioClient(
    { ...config, ...overrides },
    {
      fetch,
      sleep: async (ms) => {
        sleeps.push(ms)
      },
    },
  )
  const body = (index: number) => JSON.parse(String(calls[index]?.init.body))
  return { client, calls, sleeps, body }
}

async function failure(promise: Promise<unknown>): Promise<AttioError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof AttioError) return error
    throw error
  }
  throw new Error("expected the request to fail")
}

describe("unit: attio client", () => {
  test("upserts the person by email address", async () => {
    const { client, calls, body } = harness([personUpserted])

    expect(await client.upsertPerson("a@b.com")).toBe("rec_123")
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(
      "https://api.attio.com/v2/objects/people/records?matching_attribute=email_addresses",
    )
    expect(calls[0].init.method).toBe("PUT")
    expect(calls[0].init.headers).toEqual({
      authorization: "Bearer test-key",
      "content-type": "application/json",
      accept: "application/json",
    })
    expect(body(0)).toEqual({
      data: { values: { email_addresses: [{ email_address: "a@b.com" }] } },
    })
  })

  test("adds the person to the configured list", async () => {
    const { client, calls, body } = harness([personUpserted, entryUpserted])

    expect(await client.addToWaitlist({ email: "a@b.com" })).toEqual({
      recordId: "rec_123",
      listed: true,
    })
    expect(calls).toHaveLength(2)
    expect(calls[1].url).toBe("https://api.attio.com/v2/lists/waitlist/entries")
    expect(calls[1].init.method).toBe("PUT")
    expect(body(1)).toEqual({
      data: {
        parent_record_id: "rec_123",
        parent_object: "people",
        entry_values: {},
      },
    })
  })

  test("escapes the list identifier in the path", async () => {
    const { client, calls } = harness([personUpserted, entryUpserted], {
      listId: "wait list/1",
    })

    await client.addToWaitlist({ email: "a@b.com" })

    expect(calls[1].url).toBe(
      "https://api.attio.com/v2/lists/wait%20list%2F1/entries",
    )
  })

  test("skips the list when none is configured", async () => {
    const { client, calls } = harness([personUpserted], { listId: undefined })

    expect(await client.addToWaitlist({ email: "a@b.com" })).toEqual({
      recordId: "rec_123",
      listed: false,
    })
    expect(calls).toHaveLength(1)
  })

  test("reports a list failure without losing the person", async () => {
    const { client } = harness([
      personUpserted,
      json(404, { code: "not_found", message: "List not found" }),
    ])

    const result = await client.addToWaitlist({ email: "a@b.com" })

    expect(result.recordId).toBe("rec_123")
    expect(result.listed).toBe(false)
    if (result.listed) throw new Error("unreachable")
    expect(result.listError).toBeInstanceOf(AttioError)
    expect(result.listError?.kind).toBe("not_found")
    expect(result.listError?.status).toBe(404)
    expect(result.listError?.message).toBe("List not found")
  })

  test("attaches a timeout signal to every request", async () => {
    const { client, calls } = harness([personUpserted])

    await client.upsertPerson("a@b.com")

    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal)
  })

  test("retries once on 429, honouring Retry-After in seconds", async () => {
    const { client, calls, sleeps } = harness([
      json(429, {}, { "retry-after": "1" }),
      personUpserted,
    ])

    expect(await client.upsertPerson("a@b.com")).toBe("rec_123")
    expect(calls).toHaveLength(2)
    expect(sleeps).toEqual([1000])
  })

  test("caps the Retry-After wait", async () => {
    const { client, sleeps } = harness([
      json(429, {}, { "retry-after": "30" }),
      personUpserted,
    ])

    await client.upsertPerson("a@b.com")

    expect(sleeps).toEqual([2000])
  })

  test("accepts an HTTP-date Retry-After", async () => {
    const future = new Date(Date.now() + 60_000).toUTCString()
    const past = new Date(Date.now() - 60_000).toUTCString()
    const { client, sleeps } = harness([
      json(429, {}, { "retry-after": future }),
      personUpserted,
      json(429, {}, { "retry-after": past }),
      personUpserted,
    ])

    await client.upsertPerson("a@b.com")
    await client.upsertPerson("a@b.com")

    expect(sleeps).toEqual([2000, 0])
  })

  test("falls back to a short wait without Retry-After", async () => {
    const { client, sleeps } = harness([json(429, {}), personUpserted])

    await client.upsertPerson("a@b.com")

    expect(sleeps).toEqual([500])
  })

  test("gives up after the second 429", async () => {
    const { client, calls } = harness([json(429, {}), json(429, {})])

    const error = await failure(client.upsertPerson("a@b.com"))

    expect(error.kind).toBe("rate_limited")
    expect(error.status).toBe(429)
    expect(calls).toHaveLength(2)
  })

  test("retries once on 5xx", async () => {
    const { client, calls, sleeps } = harness([json(503, {}), personUpserted])

    expect(await client.upsertPerson("a@b.com")).toBe("rec_123")
    expect(calls).toHaveLength(2)
    expect(sleeps).toEqual([500])
  })

  test("does not retry client errors", async () => {
    const { client, calls, sleeps } = harness([
      json(400, { code: "validation_type", message: "invalid email domain" }),
    ])

    const error = await failure(client.upsertPerson("a@b.com"))

    expect(error.kind).toBe("invalid_input")
    expect(error.status).toBe(400)
    expect(error.code).toBe("validation_type")
    expect(error.message).toBe("invalid email domain")
    expect(calls).toHaveLength(1)
    expect(sleeps).toEqual([])
  })

  test("maps authentication failures", async () => {
    for (const status of [401, 403]) {
      const { client } = harness([json(status, { message: "nope" })])
      expect((await failure(client.upsertPerson("a@b.com"))).kind).toBe("auth")
    }
  })

  test("maps MULTIPLE_MATCH_RESULTS by code regardless of status", async () => {
    const { client } = harness([
      json(400, { code: "MULTIPLE_MATCH_RESULTS", message: "dupes" }),
    ])

    const error = await failure(client.upsertPerson("a@b.com"))

    expect(error.kind).toBe("multiple_matches")
    expect(error.code).toBe("MULTIPLE_MATCH_RESULTS")
  })

  test("copes with non-JSON error bodies and truncates long messages", async () => {
    const html = () => new Response("x".repeat(2000), { status: 500 })
    const { client } = harness([html, html])

    const error = await failure(client.upsertPerson("a@b.com"))

    expect(error.kind).toBe("server")
    expect(error.status).toBe(500)
    expect(error.message).toHaveLength(500)
  })

  test("describes empty error bodies by status", async () => {
    const { client } = harness([() => new Response(null, { status: 418 })])

    const error = await failure(client.upsertPerson("a@b.com"))

    expect(error.kind).toBe("unexpected")
    expect(error.message).toBe("Attio responded 418")
  })

  test("ignores JSON error bodies that are not objects", async () => {
    const { client } = harness([json(400, null)])

    const error = await failure(client.upsertPerson("a@b.com"))

    expect(error.kind).toBe("invalid_input")
    expect(error.code).toBeUndefined()
    expect(error.message).toBe("null")
  })

  test("maps timeouts without retrying", async () => {
    const { client, calls, sleeps } = harness([
      throwing(new DOMException("timed out", "TimeoutError")),
    ])

    const error = await failure(client.upsertPerson("a@b.com"))

    expect(error.kind).toBe("timeout")
    expect(calls).toHaveLength(1)
    expect(sleeps).toEqual([])
  })

  test("retries once on a network error", async () => {
    const { client, calls, sleeps } = harness([
      throwing(new TypeError("fetch failed")),
      personUpserted,
    ])

    expect(await client.upsertPerson("a@b.com")).toBe("rec_123")
    expect(calls).toHaveLength(2)
    expect(sleeps).toEqual([500])
  })

  test("gives up after the second network error", async () => {
    const { client, calls } = harness([
      throwing(new TypeError("fetch failed")),
      throwing(new TypeError("fetch failed")),
    ])

    const error = await failure(client.upsertPerson("a@b.com"))

    expect(error.kind).toBe("network")
    expect(error.cause).toBeInstanceOf(TypeError)
    expect(calls).toHaveLength(2)
  })

  test("rejects a 2xx without a data envelope", async () => {
    const { client } = harness([json(200, {})])

    const error = await failure(client.upsertPerson("a@b.com"))

    expect(error.kind).toBe("unexpected")
    expect(error.status).toBe(200)
  })

  test("rejects a 2xx with a non-JSON body", async () => {
    const { client } = harness([() => new Response("ok", { status: 200 })])

    expect((await failure(client.upsertPerson("a@b.com"))).kind).toBe(
      "unexpected",
    )
  })

  test("rethrows non-Attio failures from the list step", async () => {
    const { fetch } = fakeFetch([personUpserted])
    const client = createAttioClient(config, {
      fetch,
      sleep: async () => {
        throw new Error("boom")
      },
    })
    // The second fetch has no queued response, so it throws a plain Error,
    // which the client retries after sleeping; the sleep itself then throws.
    await expect(client.addToWaitlist({ email: "a@b.com" })).rejects.toThrow(
      "boom",
    )
  })

  test("never leaks the API key into errors", async () => {
    const { client } = harness([
      json(401, { message: "Unauthorized" }),
      throwing(new TypeError("fetch failed")),
      throwing(new TypeError("fetch failed")),
    ])

    for (const error of [
      await failure(client.upsertPerson("a@b.com")),
      await failure(client.upsertPerson("a@b.com")),
    ]) {
      expect(error.message).not.toContain("test-key")
      expect(JSON.stringify(error)).not.toContain("test-key")
      expect(String(error.cause)).not.toContain("test-key")
    }
  })
})

describe("unit: attio config", () => {
  test("returns undefined without ATTIO_API_KEY", () => {
    expect(parseAttioConfig({})).toBeUndefined()
    expect(parseAttioConfig({ ATTIO_API_KEY: "  " })).toBeUndefined()
  })

  test("reads the key and the optional list, trimmed", () => {
    expect(
      parseAttioConfig({
        ATTIO_API_KEY: " k ",
        ATTIO_WAITLIST_LIST: " waitlist ",
      }),
    ).toEqual({ apiKey: "k", listId: "waitlist" })
    expect(
      parseAttioConfig({ ATTIO_API_KEY: "k", ATTIO_WAITLIST_LIST: "" }),
    ).toEqual({ apiKey: "k" })
  })
})
