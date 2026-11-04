import { afterAll, expect, test } from "bun:test"
import { cleanup } from "./cleanup"
import { readMail, startFakePostmark } from "./postmark"

const token = "fake-server-token"
const fake = startFakePostmark({ token })
afterAll(() => cleanup())

const send = (body: unknown, headers: Record<string, string> = { "X-Postmark-Server-Token": token }) =>
  fetch(fake.url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) })
const email = { From: "ID <sign-in@id.example.com>", To: "ada@firm.example", Subject: "Sign in", TextBody: "Sign in https://id.example.com/magic-link?token=abc\n\n04817352\n", Tag: "sign-in", TrackOpens: false, TrackLinks: "None" }

test("answers as Postmark does and keeps the message", async () => {
  const before = Date.now() - 1
  const response = await send({ ...email, ReplyTo: "support@example.com", HtmlBody: "<p>hi</p>" })
  expect(response.status).toBe(200)
  const answer = (await response.json()) as { ErrorCode: number; Message: string; MessageID: string; To: string }
  expect(answer).toMatchObject({ ErrorCode: 0, Message: "OK", To: "ada@firm.example" })
  expect(fake.messages()).toEqual([
    {
      id: answer.MessageID,
      from: email.From,
      to: email.To,
      replyTo: "support@example.com",
      subject: "Sign in",
      html: "<p>hi</p>",
      text: email.TextBody,
      tag: "sign-in",
      tracking: { opens: false, links: "None" },
      receivedAt: expect.any(Number),
    },
  ])
  expect(fake.messages()[0]!.receivedAt).toBeGreaterThan(before)
})

test("refuses a request without the server token, or with another, and keeps nothing", async () => {
  const kept = fake.messages().length
  for (const headers of [{}, { "X-Postmark-Server-Token": "another-token" }, { "X-Postmark-Server-Token": "" }] as Record<string, string>[]) {
    const response = await send(email, headers)
    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({ ErrorCode: 10 })
  }
  // The inbox is behind the token too.
  expect((await fetch(fake.inbox)).status).toBe(401)
  expect(fake.messages()).toHaveLength(kept)
})

test("refuses a request that is not an email, with Postmark's 422 and code 300", async () => {
  const kept = fake.messages().length
  for (const body of ["not json", "null", {}, { ...email, From: undefined }, { ...email, To: "" }, { ...email, Subject: undefined }, { ...email, TextBody: undefined }]) {
    const response = await send(body)
    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({ ErrorCode: 300 })
  }
  expect(fake.messages()).toHaveLength(kept)
})

test("takes an email with an HTML part alone", async () => {
  const response = await send({ ...email, To: "html@firm.example", TextBody: undefined, HtmlBody: "<p>hi</p>" })
  expect(response.status).toBe(200)
  expect(fake.messages().at(-1)).toMatchObject({ to: "html@firm.example", text: "", html: "<p>hi</p>", replyTo: null })
})

test("answers 422 with code 406 for an inactive recipient, and keeps nothing", async () => {
  const kept = fake.messages().length
  const response = await send({ ...email, To: "inactive@firm.example" })
  expect(response.status).toBe(422)
  expect(await response.json()).toMatchObject({ ErrorCode: 406 })
  expect(fake.messages()).toHaveLength(kept)
})

test("serves what it kept at /fake/messages, one recipient's with ?to=, and answers 404 elsewhere", async () => {
  await send({ ...email, To: "grace@firm.example" })
  const headers = { "X-Postmark-Server-Token": token }
  const all = (await (await fetch(fake.inbox, { headers })).json()) as { to: string }[]
  expect(all.map((mail) => mail.to)).toEqual(fake.messages().map((mail) => mail.to))
  const grace = (await (await fetch(`${fake.inbox}?to=grace@firm.example`, { headers })).json()) as { to: string }[]
  expect(grace.map((mail) => mail.to)).toEqual(["grace@firm.example"])
  expect((await fetch(`${fake.url}x`, { method: "POST", headers })).status).toBe(404)
  expect((await fetch(fake.url, { headers })).status).toBe(404)
})

test("waitFor returns the first email to an address after a time, and throws when none comes", async () => {
  const found = await fake.waitFor("grace@firm.example")
  expect(found.to).toBe("grace@firm.example")
  // Not before `after`.
  await expect(fake.waitFor("grace@firm.example", { after: found.receivedAt, timeoutMs: 250 })).rejects.toThrow("No email to grace@firm.example reached the fake Postmark within 0.25 s")
  const later = send({ ...email, To: "later@firm.example" })
  expect((await fake.waitFor("later@firm.example")).to).toBe("later@firm.example")
  await later
})

test("readMail finds the link and the code in the text part", () => {
  expect(readMail({ text: email.TextBody })).toEqual({ link: "https://id.example.com/magic-link?token=abc", code: "04817352" })
  expect(readMail({ text: "nothing here" })).toEqual({ link: null, code: null })
})
