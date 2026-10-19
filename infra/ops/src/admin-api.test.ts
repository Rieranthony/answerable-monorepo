import { expect, test } from "bun:test"
import { adminApi, failure, RootLocked } from "./admin-api"

const api = (answer: () => Response, seen: { url?: string; headers?: Headers; body?: unknown }[] = []) =>
  adminApi({
    id: "https://id.example",
    token: "the-token",
    rootLocked: "locked, says the command",
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(input), headers: new Headers(init?.headers), body: init?.body })
      return answer()
    }) as typeof globalThis.fetch,
  })

test("sends the bearer, the key, If-None-Match and a JSON body, and answers the status, the body and whether ID replayed", async () => {
  const seen: { url?: string; headers?: Headers; body?: unknown }[] = []
  const call = api(() => Response.json({ id: "x" }, { status: 201, headers: { "Idempotency-Replayed": "true" } }), seen)
  expect(await call("PUT", "/thing", { key: "a-key", ifNoneMatch: true, body: { a: 1 } })).toEqual({ status: 201, ok: true, body: { id: "x" }, replayed: true })
  expect(seen[0]!.url).toBe("https://id.example/api/admin/v1/thing")
  expect(seen[0]!.headers!.toJSON()).toEqual({ authorization: "Bearer the-token", "idempotency-key": "a-key", "if-none-match": "*", "content-type": "application/json" })
  expect(seen[0]!.body).toBe('{"a":1}')
  expect(await api(() => new Response(null, { status: 204 }))("GET", "/empty")).toEqual({ status: 204, ok: true, body: {}, replayed: false })
})

test("an answer that is not JSON keeps its first 200 characters as the detail", async () => {
  const answer = await api(() => new Response(`<html>${"x".repeat(300)}`, { status: 502 }))("GET", "/broken")
  expect(answer).toMatchObject({ status: 502, ok: false })
  expect(answer.body.detail).toHaveLength(200)
  expect(failure("GET", "/broken", answer).message).toBe("GET /broken answered 502")
})

test("root_locked is the command's RootLocked, and a reused key is an error naming it", async () => {
  const locked = api(() => Response.json({ code: "root_locked" }, { status: 403 }))("GET", "/organizations")
  await expect(locked).rejects.toBeInstanceOf(RootLocked)
  await expect(locked).rejects.toThrow("locked, says the command")
  await expect(api(() => Response.json({ code: "idempotency_key_reused" }, { status: 409 }))("POST", "/x", { key: "k-v1" })).rejects.toThrow("ID refused Idempotency-Key k-v1: it was used before with different input")
})
