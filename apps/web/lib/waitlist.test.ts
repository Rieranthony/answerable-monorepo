import { describe, expect, mock, test } from "bun:test"
import { HEADERS, type SheetsConfig } from "./sheets"
import { fakeWorksheet } from "./test-helpers"
import { MESSAGES, submitWaitlist } from "./waitlist"

const productionEnv = {
  NODE_ENV: "production",
  GOOGLE_SHEETS_ID: "sheet-id",
  GOOGLE_SERVICE_ACCOUNT_EMAIL: "sa@x.iam.gserviceaccount.com",
  GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY:
    "-----BEGIN PRIVATE KEY-----\\nTESTKEY\\n-----END PRIVATE KEY-----\\n",
}
function harness(
  initial: Parameters<typeof fakeWorksheet>[0] = { headers: [...HEADERS] },
  env: Record<string, string | undefined> = productionEnv,
) {
  const fake = fakeWorksheet(initial)
  const log = {
    error: mock<(line: string) => void>(() => {}),
    info: mock<(line: string) => void>(() => {}),
  }
  const opened: SheetsConfig[] = []
  const submit = (email: string) =>
    submitWaitlist(email, {
      env,
      log,
      openWorksheet: async (config) => {
        opened.push(config)
        return fake.worksheet
      },
      now: () => new Date("2026-09-09T10:00:00.000Z"),
    })
  const lines = (level: keyof typeof log) =>
    log[level].mock.calls.map((call) => call[0])
  return { ...fake, log, opened, submit, lines }
}
const success = { status: "success", email: "a@b.com" } as const
const failed = { status: "error", message: MESSAGES.failed } as const

describe("unit: waitlist", () => {
  test("rejects empty and whitespace-only input before opening the sheet", async () => {
    const h = harness()
    for (const email of ["", "   "])
      expect(await h.submit(email)).toEqual({
        status: "error",
        message: MESSAGES.empty,
      })
    expect(h.opened).toEqual([])
  })
  test("rejects malformed and overlong addresses before opening the sheet", async () => {
    const h = harness()
    for (const email of ["nope", "a@b", "a b@c.d", `${"a".repeat(250)}@b.com`])
      expect(await h.submit(email)).toEqual({
        status: "error",
        message: MESSAGES.invalid,
      })
    expect(h.opened).toEqual([])
  })
  test("stores trimmed lowercase addresses", async () => {
    const h = harness()
    expect(await h.submit("  Foo@Example.COM ")).toEqual({
      status: "success",
      email: "foo@example.com",
    })
    expect(h.rows[0].email).toBe("foo@example.com")
  })
  test("logs and succeeds unconfigured outside production", async () => {
    const h = harness(undefined, { NODE_ENV: "development" })
    expect(await h.submit("a@b.com")).toEqual(success)
    expect(h.lines("info")).toEqual([
      '[waitlist] sheets_not_configured_signup_logged_only {"email":"a@b.com"}',
    ])
    expect(h.log.error).not.toHaveBeenCalled()
    expect(h.opened).toEqual([])
  })
  test("fails unconfigured in production", async () => {
    const h = harness(undefined, { NODE_ENV: "production" })
    expect(await h.submit("a@b.com")).toEqual(failed)
    expect(h.lines("error")).toEqual([
      '[waitlist] sheets_not_configured {"email":"a@b.com"}',
    ])
    expect(h.log.info).not.toHaveBeenCalled()
    expect(h.opened).toEqual([])
  })
  test("treats partial config as unconfigured", async () => {
    const h = harness(undefined, {
      NODE_ENV: "production",
      GOOGLE_SHEETS_ID: "sheet-id",
    })
    expect(await h.submit("a@b.com")).toEqual(failed)
    expect(h.lines("error")).toEqual([
      '[waitlist] sheets_not_configured {"email":"a@b.com"}',
    ])
    expect(h.opened).toEqual([])
  })
  test("inserts successfully without logging", async () => {
    const h = harness()
    expect(await h.submit("a@b.com")).toEqual(success)
    expect(h.rows).toHaveLength(1)
    expect(h.log.error).not.toHaveBeenCalled()
    expect(h.log.info).not.toHaveBeenCalled()
  })
  test("logs header creation on first use", async () => {
    const h = harness({})
    expect(await h.submit("a@b.com")).toEqual(success)
    expect(h.lines("info")).toEqual([
      '[waitlist] sheets_header_created {"email":"a@b.com"}',
    ])
    expect(h.log.error).not.toHaveBeenCalled()
  })
  test("repeated submissions succeed and leave one row", async () => {
    const h = harness()
    expect(await h.submit("a@b.com")).toEqual(success)
    expect(await h.submit("a@b.com")).toEqual(success)
    expect(h.rows).toHaveLength(1)
    expect(h.calls.addRow).toHaveLength(1)
    expect(h.calls.save).toHaveLength(1)
  })
  test("logs worksheet failures and returns the generic message", async () => {
    const h = harness({
      fail: {
        loadHeaderRow: new Error(
          "Google API error - [403] The caller does not have permission",
        ),
      },
    })
    expect(await h.submit("a@b.com")).toEqual(failed)
    expect(h.lines("error")).toEqual([
      '[waitlist] sheets_failed {"email":"a@b.com","message":"Google API error - [403] The caller does not have permission"}',
    ])
  })
  test("truncates logged error messages to 500 characters", async () => {
    const h = harness({ fail: { loadHeaderRow: new Error("x".repeat(700)) } })
    expect(await h.submit("a@b.com")).toEqual(failed)
    expect(h.lines("error")).toEqual([
      `[waitlist] sheets_failed ${JSON.stringify({ email: "a@b.com", message: "x".repeat(500) })}`,
    ])
  })
  test("redacts every private key occurrence before truncating", async () => {
    const key = productionEnv.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY.replace(
      /\\n/g,
      "\n",
    )
    const h = harness({
      fail: { loadHeaderRow: new Error(`before ${key} middle ${key} after`) },
    })
    expect(await h.submit("a@b.com")).toEqual(failed)
    expect(h.lines("error")).toEqual([
      '[waitlist] sheets_failed {"email":"a@b.com","message":"before [redacted] middle [redacted] after"}',
    ])
    expect(h.lines("error").join()).not.toContain("TESTKEY")
    expect(h.opened[0].privateKey).toBe(key)
  })
  test("logs non-Error throws", async () => {
    const h = harness({ fail: { loadHeaderRow: "boom" } })
    expect(await h.submit("a@b.com")).toEqual(failed)
    expect(h.lines("error")).toEqual([
      '[waitlist] sheets_failed {"email":"a@b.com","message":"boom"}',
    ])
  })
})
