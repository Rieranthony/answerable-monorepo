import { describe, expect, test } from "bun:test"
import {
  createSheetsClient,
  HEADERS,
  parseSheetsConfig,
  type SheetsConfig,
} from "./sheets"
import { fakeWorksheet } from "./test-helpers"

const config: SheetsConfig = {
  spreadsheetId: "sheet-id",
  clientEmail: "sa@example.com",
  privateKey: "key",
}
const at = "2026-09-09T10:00:00.000Z"
function harness(
  initial: Parameters<typeof fakeWorksheet>[0] = { headers: [...HEADERS] },
) {
  const fake = fakeWorksheet(initial)
  const opened: SheetsConfig[] = []
  const client = createSheetsClient(config, {
    openWorksheet: async (c) => {
      opened.push(c)
      return fake.worksheet
    },
    now: () => new Date(at),
  })
  return { ...fake, opened, client }
}
function noWrites(calls: ReturnType<typeof fakeWorksheet>["calls"]) {
  expect(calls.setHeaderRow).toEqual([])
  expect(calls.addRow).toEqual([])
  expect(calls.save).toEqual([])
}

describe("unit: sheets config", () => {
  const env = {
    GOOGLE_SHEETS_ID: " id ",
    GOOGLE_SERVICE_ACCOUNT_EMAIL: " sa@example.com ",
    GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: " key\\nline\\n ",
  }
  test("requires every variable to be present and nonblank", () => {
    expect(parseSheetsConfig({})).toBeUndefined()
    for (const key of Object.keys(env)) {
      for (const value of [undefined, "", " \n "]) {
        expect(parseSheetsConfig({ ...env, [key]: value })).toBeUndefined()
      }
    }
  })
  test("trims all values and normalises literal newlines", () => {
    expect(parseSheetsConfig(env)).toEqual({
      spreadsheetId: "id",
      clientEmail: "sa@example.com",
      privateKey: "key\nline\n",
    })
  })
})

describe("unit: sheets client", () => {
  test("passes config to the worksheet opener", async () => {
    const h = harness()
    await h.client.upsertEmail("a@b.com")
    expect(h.opened).toEqual([config])
  })
  test("creates a blank sheet header once and appends raw strings", async () => {
    const h = harness({})
    expect(await h.client.upsertEmail("a@b.com")).toEqual({
      outcome: "inserted",
      headerCreated: true,
    })
    expect(h.headers()).toEqual([...HEADERS])
    expect(h.calls.setHeaderRow).toEqual([[...HEADERS]])
    expect(h.calls.addRow).toEqual([
      {
        values: { email: "a@b.com", first_seen_at: at, last_seen_at: at },
        options: { raw: true },
      },
    ])
    expect(h.rows).toEqual([h.calls.addRow[0].values])
    await h.client.upsertEmail("a@b.com")
    expect(h.calls.setHeaderRow).toHaveLength(1)
    expect(h.rows).toHaveLength(1)
  })
  test("recognises the all-blank header error", async () => {
    const h = harness({
      fail: {
        loadHeaderRow: new Error(
          "All your header cells are blank - provide headers",
        ),
      },
    })
    expect(await h.client.upsertEmail("a@b.com")).toEqual({
      outcome: "inserted",
      headerCreated: true,
    })
    expect(h.calls.setHeaderRow).toEqual([[...HEADERS]])
    expect(h.calls.addRow).toHaveLength(1)
  })
  test("appends once without changing an existing header", async () => {
    const h = harness()
    expect(await h.client.upsertEmail("a@b.com")).toEqual({
      outcome: "inserted",
      headerCreated: false,
    })
    expect(h.calls.setHeaderRow).toEqual([])
    expect(h.calls.addRow).toHaveLength(1)
    expect(h.calls.loadHeaderRow).toBe(1)
    expect(h.calls.getRows).toBe(1)
  })
  for (const email of ["a@b.com", "  A@B.COM "]) {
    test(`updates only last_seen_at for matching ${JSON.stringify(email)}`, async () => {
      const original = { email, first_seen_at: "original", last_seen_at: "old" }
      const h = harness({ headers: [...HEADERS], rows: [original] })
      expect(await h.client.upsertEmail("a@b.com")).toEqual({
        outcome: "updated",
        headerCreated: false,
      })
      expect(h.rows).toEqual([{ ...original, last_seen_at: at }])
      expect(h.calls.save).toEqual([{ row: h.rows[0], options: { raw: true } }])
      expect(h.calls.addRow).toEqual([])
    })
  }
  test("accepts extra columns and different order", async () => {
    const h = harness({
      headers: ["note", "last_seen_at", "email", "first_seen_at"],
    })
    await h.client.upsertEmail("a@b.com")
    expect(h.rows).toEqual([
      { note: "", email: "a@b.com", first_seen_at: at, last_seen_at: at },
    ])
    expect(h.calls.setHeaderRow).toEqual([])
  })
  for (const missing of HEADERS) {
    test(`rejects a missing ${missing} column without writing`, async () => {
      const h = harness({ headers: HEADERS.filter((key) => key !== missing) })
      await expect(h.client.upsertEmail("a@b.com")).rejects.toThrow(missing)
      noWrites(h.calls)
      expect(h.calls.getRows).toBe(0)
    })
  }
  test("reports all missing columns and the expected header", async () => {
    const h = harness({ headers: ["note"] })
    await expect(h.client.upsertEmail("a@b.com")).rejects.toThrow(
      "email, first_seen_at, last_seen_at",
    )
    noWrites(h.calls)
  })
  test("rethrows permission failures without writing a header", async () => {
    const error = new Error(
      "Google API error - [403] The caller does not have permission",
    )
    const h = harness({ fail: { loadHeaderRow: error } })
    await expect(h.client.upsertEmail("a@b.com")).rejects.toBe(error)
    noWrites(h.calls)
  })
  for (const method of ["addRow", "save", "getRows", "setHeaderRow"] as const) {
    test(`propagates ${method} failures`, async () => {
      const error = new Error(`${method} failed`)
      const h = harness({
        headers: method === "setHeaderRow" ? undefined : [...HEADERS],
        rows: method === "save" ? [{ email: "a@b.com" }] : [],
        fail: { [method]: error },
      })
      await expect(h.client.upsertEmail("a@b.com")).rejects.toBe(error)
    })
  }
})
