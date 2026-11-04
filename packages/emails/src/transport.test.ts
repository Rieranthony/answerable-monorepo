import { describe, expect, test } from "bun:test"
import { renderEmail } from "./render"
import { link } from "./fixtures"
import {
  createLogTransport,
  createPostmarkTransport,
  postmarkErrorCode,
  type Message,
} from "./transport"

const TOKEN = "server-token-SECRET-1234"
const to = "alice@example.com"
const message: Message = { to, ...renderEmail(link) }

type Call = { url: string; init: RequestInit }
type Answer = Response | Error | "hang"

const ok = (messageId = "msg-1") =>
  Response.json({ ErrorCode: 0, Message: "OK", MessageID: messageId, To: to })
const refused = (status: number, errorCode: number) =>
  Response.json(
    { ErrorCode: errorCode, Message: `The address ${to} said no` },
    { status },
  )

/** A fetch that answers in turn and records each call. "hang" never answers: only the timeout ends it. */
function fakeFetch(...answers: Answer[]) {
  const calls: Call[] = []
  const fetch = (url: string, init: RequestInit): Promise<Response> => {
    calls.push({ url, init })
    const answer = answers[calls.length - 1]
    if (answer === undefined)
      throw new Error("fetch called more often than the test expected")
    if (answer instanceof Error) return Promise.reject(answer)
    if (answer === "hang") {
      return new Promise((_, reject) =>
        init.signal!.addEventListener("abort", () =>
          reject(init.signal!.reason),
        ),
      )
    }
    return Promise.resolve(answer)
  }
  return { fetch, calls }
}

const transport = (
  answers: Answer[],
  options: { subjectPrefix?: string; endpoint?: string } = {},
) => {
  const { fetch, calls } = fakeFetch(...answers)
  return {
    calls,
    transport: createPostmarkTransport({
      serverToken: TOKEN,
      from: "Answerable ID <sign-in@id.example.com>",
      replyTo: "support@example.com",
      fetch,
      timeoutMs: 50,
      retryDelayMs: 0,
      ...options,
    }),
  }
}

describe("the request", () => {
  test("is exactly Postmark's email call, with tracking off and nothing in Metadata", async () => {
    const { transport: postmark, calls } = transport([ok("msg-42")])
    expect(await postmark.send(message)).toEqual({
      status: "sent",
      messageId: "msg-42",
    })
    expect(calls).toHaveLength(1)
    const [{ url, init }] = calls as [Call]
    expect(url).toBe("https://api.postmarkapp.com/email")
    expect(init.method).toBe("POST")
    expect(init.headers).toEqual({
      "X-Postmark-Server-Token": TOKEN,
      Accept: "application/json",
      "Content-Type": "application/json",
    })
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(JSON.parse(init.body as string)).toEqual({
      From: "Answerable ID <sign-in@id.example.com>",
      To: to,
      ReplyTo: "support@example.com",
      Subject: "Sign in to Acme Surveyors",
      HtmlBody: message.html,
      TextBody: message.text,
      Tag: "sign-in",
      MessageStream: "outbound",
      TrackOpens: false,
      TrackLinks: "None",
      Headers: [
        { Name: "Auto-Submitted", Value: "auto-generated" },
        { Name: "X-Auto-Response-Suppress", Value: "All" },
      ],
    })
  })

  test("carries no secret in Tag or in any field but the two bodies", async () => {
    const { transport: postmark, calls } = transport([ok()])
    await postmark.send(message)
    const body = JSON.parse(calls[0]!.init.body as string) as Record<
      string,
      unknown
    >
    expect(body).not.toHaveProperty("Metadata")
    for (const [field, value] of Object.entries(body)) {
      if (field === "HtmlBody" || field === "TextBody") continue
      expect(JSON.stringify(value), field).not.toContain("token=abc123")
      expect(JSON.stringify(value), field).not.toContain(link.code)
      expect(JSON.stringify(value), field).not.toContain(TOKEN)
    }
  })

  test("goes to the endpoint it is given, a fake Postmark's, with the same call and the retry too", async () => {
    const endpoint = "https://127.0.0.1:47712/email"
    const { transport: postmark, calls } = transport([ok("msg-fake")], {
      endpoint,
    })
    expect(await postmark.send(message)).toEqual({
      status: "sent",
      messageId: "msg-fake",
    })
    expect(calls.map((call) => call.url)).toEqual([endpoint])
    expect(
      (calls[0]!.init.headers as Record<string, string>)[
        "X-Postmark-Server-Token"
      ],
    ).toBe(TOKEN)
    const retried = transport([new Error("reset"), ok("msg-again")], {
      endpoint,
    })
    expect(await retried.transport.send(message)).toEqual({
      status: "sent",
      messageId: "msg-again",
    })
    expect(retried.calls.map((call) => call.url)).toEqual([endpoint, endpoint])
  })

  test("puts a prefix before the subject, for an environment that is not production", async () => {
    const { transport: postmark, calls } = transport([ok()], {
      subjectPrefix: "[staging]",
    })
    await postmark.send(message)
    expect(JSON.parse(calls[0]!.init.body as string).Subject).toBe(
      "[staging] Sign in to Acme Surveyors",
    )
  })

  test("refuses a recipient that is a list, has a name or holds a break, before anything is sent", async () => {
    const { transport: postmark, calls } = transport([])
    for (const bad of [
      "a@example.com, b@example.com",
      "a@example.com;b@example.com",
      "Alice <a@example.com>",
      "a@example.com\r\nBcc: b@example.com",
      "a b@example.com",
      "",
      '"a,b"@example.com',
    ]) {
      await expect(postmark.send({ ...message, to: bad })).rejects.toThrow(
        "one plain address",
      )
    }
    expect(calls).toHaveLength(0)
  })
})

describe("an answer that is final", () => {
  test("is a sent message with Postmark's id", async () => {
    expect(await transport([ok("abc")]).transport.send(message)).toEqual({
      status: "sent",
      messageId: "abc",
    })
  })

  test("is not retried when it is a refusal: 401, 406, 412, 413, any other 4xx", async () => {
    const cases: [number, number][] = [
      [401, 10],
      [422, postmarkErrorCode.inactiveRecipient],
      [422, postmarkErrorCode.pendingApproval],
      [422, postmarkErrorCode.accountNotApproved],
      [422, 300],
      [400, 402],
      [403, 1480],
      [413, 0],
    ]
    for (const [status, errorCode] of cases) {
      const { transport: postmark, calls } = transport([
        refused(status, errorCode),
      ])
      expect(await postmark.send(message), `${status}/${errorCode}`).toEqual({
        status: "failed",
        httpStatus: status,
        errorCode,
        retried: false,
      })
      expect(calls).toHaveLength(1)
    }
  })

  test("names the codes a caller acts on", () => {
    expect(postmarkErrorCode).toEqual({
      inactiveRecipient: 406,
      pendingApproval: 412,
      accountNotApproved: 413,
    })
  })

  test("is failed, never retried and never a throw when a 2xx cannot be read: Postmark may have sent it", async () => {
    for (const answer of [
      new Response("<html>not json</html>", { status: 200 }),
      Response.json({}),
      Response.json({ ErrorCode: 0 }),
      Response.json({ ErrorCode: 0, MessageID: "" }),
      Response.json({ ErrorCode: 0, MessageID: 7 }),
      Response.json(null),
      Response.json({ ErrorCode: 5, Message: "odd", MessageID: "m" }),
    ]) {
      const { transport: postmark, calls } = transport([answer])
      const result = await postmark.send(message)
      expect(result).toMatchObject({
        status: "failed",
        httpStatus: 200,
        retried: false,
      })
      expect(calls).toHaveLength(1)
    }
  })
})

describe("the one retry", () => {
  test("happens on a 429, a 500, a 503, a network error and a timeout, and reports the second answer", async () => {
    const first: Answer[] = [
      refused(429, 0),
      refused(500, 101),
      refused(503, 100),
      new TypeError("fetch failed"),
      "hang",
    ]
    for (const answer of first) {
      const { transport: postmark, calls } = transport([answer, ok("second")])
      expect(await postmark.send(message)).toEqual({
        status: "sent",
        messageId: "second",
      })
      expect(calls).toHaveLength(2)
      expect(calls[1]!.init.body).toBe(calls[0]!.init.body)
    }
  })

  test("is the last: a second failure is reported with retried set", async () => {
    const cases: [Answer, Answer, number | null, number | null][] = [
      [refused(429, 0), refused(429, 0), 429, 0],
      [refused(500, 101), refused(503, 100), 503, 100],
      [refused(500, 101), refused(422, 406), 422, 406],
      [
        new TypeError("fetch failed"),
        new TypeError("fetch failed"),
        null,
        null,
      ],
      ["hang", "hang", null, null],
      ["hang", refused(500, 101), 500, 101],
      [
        refused(500, 101),
        new Response("<html>bad gateway</html>", { status: 502 }),
        502,
        null,
      ],
    ]
    for (const [a, b, httpStatus, errorCode] of cases) {
      const { transport: postmark, calls } = transport([a, b])
      expect(await postmark.send(message)).toEqual({
        status: "failed",
        httpStatus,
        errorCode,
        retried: true,
      })
      expect(calls).toHaveLength(2)
    }
  })

  test("waits retryDelayMs first", async () => {
    const { fetch } = fakeFetch(refused(500, 101), ok())
    const postmark = createPostmarkTransport({
      serverToken: TOKEN,
      from: "a@example.com",
      replyTo: "b@example.com",
      fetch,
      retryDelayMs: 60,
    })
    const started = performance.now()
    await postmark.send(message)
    expect(performance.now() - started).toBeGreaterThanOrEqual(50)
  })
})

describe("the timeout", () => {
  test("ends an attempt that never answers, through an abort signal", async () => {
    const { transport: postmark, calls } = transport(["hang", "hang"])
    const started = performance.now()
    const result = await postmark.send(message)
    expect(result).toEqual({
      status: "failed",
      httpStatus: null,
      errorCode: null,
      retried: true,
    })
    expect(calls.every(({ init }) => init.signal!.aborted)).toBe(true)
    expect(performance.now() - started).toBeLessThan(2_000)
  })

  test("is ten seconds unless told otherwise", async () => {
    const { fetch, calls } = fakeFetch(ok())
    await createPostmarkTransport({
      serverToken: TOKEN,
      from: "a@example.com",
      replyTo: "b@example.com",
      fetch,
    }).send(message)
    expect(calls[0]!.init.signal!.aborted).toBe(false)
  })
})

describe("a result", () => {
  test("never holds the token, the link, the code, the address or Postmark's words", async () => {
    const cases: Answer[][] = [
      [refused(422, 406)],
      [refused(401, 10)],
      [
        new Error(
          `connect to api.postmarkapp.com failed with ${TOKEN} for ${to} link ${link.url} code ${link.code}`,
        ),
        new Error(`${TOKEN}`),
      ],
      [
        Response.json(
          { ErrorCode: 0, Message: `Sent ${TOKEN} to ${to}` },
          { status: 200 },
        ),
      ],
      ["hang", "hang"],
    ]
    for (const answers of cases) {
      const { transport: postmark } = transport(answers)
      const result = JSON.stringify(await postmark.send(message))
      for (const secret of [
        TOKEN,
        to,
        link.url,
        link.code,
        "token=abc123",
        "said no",
        "connect to",
      ]) {
        expect(result, secret).not.toContain(secret)
      }
    }
  })

  test("is the only thing a Postmark failure produces: no throw reaches the caller", async () => {
    for (const answer of [
      new Error("boom"),
      new TypeError("x"),
      "hang" as const,
      refused(500, 101),
    ]) {
      const { transport: postmark } = transport([answer, answer])
      await expect(postmark.send(message)).resolves.toMatchObject({
        status: "failed",
      })
    }
  })
})

describe("the log transport, for local development", () => {
  test("writes the recipient, the subject and the text with the link and the code, and sends nothing", async () => {
    const lines: string[] = []
    const result = await createLogTransport((line) => lines.push(line)).send(
      message,
    )
    expect(result).toEqual({ status: "sent", messageId: "local" })
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain(`Email to ${to}: Sign in to Acme Surveyors`)
    expect(lines[0]).toContain(link.url)
    expect(lines[0]).toContain(link.code)
  })
})
