import { expect, test } from "bun:test"
import { adminApi, clientToken, failure, RootLocked } from "./admin-api"

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

test("sends the bearer, the key, the preconditions and a JSON body, and answers the status, the body, the ETag and whether ID replayed", async () => {
  const seen: { url?: string; headers?: Headers; body?: unknown }[] = []
  const call = api(() => Response.json({ id: "x" }, { status: 201, headers: { "Idempotency-Replayed": "true", ETag: '"x:2"' } }), seen)
  expect(await call("PUT", "/thing", { key: "a-key", ifNoneMatch: true, body: { a: 1 } })).toEqual({ status: 201, ok: true, body: { id: "x" }, etag: '"x:2"', replayed: true })
  expect(seen[0]!.url).toBe("https://id.example/api/admin/v1/thing")
  expect(seen[0]!.headers!.toJSON()).toEqual({ authorization: "Bearer the-token", "idempotency-key": "a-key", "if-none-match": "*", "content-type": "application/json" })
  expect(seen[0]!.body).toBe('{"a":1}')
  await call("PATCH", "/thing", { key: "b-key", ifMatch: '"x:2"', body: {} })
  expect(seen[1]!.headers!.get("if-match")).toBe('"x:2"')
  expect(await api(() => new Response(null, { status: 204 }))("GET", "/empty")).toEqual({ status: 204, ok: true, body: {}, etag: null, replayed: false })
})

test("a machine client's token: asked for with its credentials on first use, reused, and asked again a minute before it expires", async () => {
  const asked: { url: string; headers: Headers; body: string }[] = []
  let expiresIn = 600
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    asked.push({ url: String(input), headers: new Headers(init?.headers), body: String(init?.body) })
    return Response.json({ access_token: `token-${asked.length}`, expires_in: expiresIn })
  }) as typeof globalThis.fetch
  const token = clientToken({ id: "https://id.example", clientId: "ops-register", clientSecret: "s3cret", refused: "refused", fetch })
  expect(await token()).toBe("token-1")
  expect(await token()).toBe("token-1")
  expect(asked).toHaveLength(1)
  expect(asked[0]!.url).toBe("https://id.example/auth/oauth2/token")
  expect(asked[0]!.headers.get("authorization")).toBe(`Basic ${Buffer.from("ops-register:s3cret").toString("base64")}`)
  expect(Object.fromEntries(new URLSearchParams(asked[0]!.body))).toEqual({ grant_type: "client_credentials", resource: "https://id.example/api/admin", scope: "platform:read platform:write" })
  // A token with a minute or less to live is renewed.
  expiresIn = 60
  const short = clientToken({ id: "https://id.example", clientId: "ops-register", clientSecret: "s3cret", refused: "refused", fetch })
  expect(await short()).toBe("token-2")
  expect(await short()).toBe("token-3")
})

test("a refused token request is the given message with ID's status, and one ID does not answer names it", async () => {
  const refusing = clientToken({ id: "https://id.example", clientId: "ops-register", clientSecret: "s3cret", refused: "ID refused ops-register", fetch: (async () => Response.json({ error: "invalid_client" }, { status: 401 })) as unknown as typeof globalThis.fetch })
  await expect(refusing()).rejects.toThrow("ID refused ops-register (ID answered 401)")
  const silent = (async (_input: string | URL | Request, init?: RequestInit) => new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)))) as typeof globalThis.fetch
  await expect(clientToken({ id: "https://id.example", clientId: "ops-register", clientSecret: "s3cret", refused: "", fetch: silent, timeoutMs: 20 })()).rejects.toThrow("ops-register's token request got no answer from ID within 0.02 s")
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
