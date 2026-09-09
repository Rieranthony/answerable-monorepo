import { describe, expect, test } from "bun:test"
import {
  COLUMNS,
  createSheetsClient,
  formatTimestamp,
  parseSheetsConfig,
  type SheetsConfig,
} from "./sheets"
import { fakeWorksheet } from "./test-helpers"

const config: SheetsConfig = {
  spreadsheetId: "sheet-id",
  clientEmail: "sa@example.com",
  privateKey: "key",
}
const nowIso = "2026-09-09T10:00:00.000Z"
const at = "2026-09-09 10:00"
const checkbox = {
  range: { startRowIndex: 1, startColumnIndex: 3, endColumnIndex: 4 },
  rule: {
    condition: { type: "BOOLEAN" as const, values: [] },
    strict: true,
    showCustomUi: true,
  },
}
const written = ["email", "first_seen_at", "last_seen_at"] as const

function harness(
  initial: Parameters<typeof fakeWorksheet>[0] = { headers: [...COLUMNS] },
  options: { timeZone?: string; now?: string } = {},
) {
  const fake = fakeWorksheet(initial)
  const opened: SheetsConfig[] = []
  const client = createSheetsClient(config, {
    openSheet: async (c) => {
      opened.push(c)
      return { sheet: fake.worksheet, timeZone: options.timeZone }
    },
    now: () => new Date(options.now ?? nowIso),
  })
  return { ...fake, opened, client }
}
function noWrites(calls: ReturnType<typeof fakeWorksheet>["calls"]) {
  expect(calls.setHeaderRow).toEqual([])
  expect(calls.setDataValidation).toEqual([])
  expect(calls.addRow).toEqual([])
  expect(calls.saveUpdatedCells).toEqual([])
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

describe("unit: sheets timestamps", () => {
  const date = new Date(nowIso)
  test("defaults to UTC without a timezone", () => {
    expect(formatTimestamp(date)).toBe(at)
    expect(formatTimestamp(date, "")).toBe(at)
  })
  test("writes the spreadsheet's local time", () => {
    expect(formatTimestamp(date, "Europe/London")).toBe("2026-09-09 11:00")
    expect(formatTimestamp(date, "America/New_York")).toBe("2026-09-09 06:00")
    expect(
      formatTimestamp(new Date("2026-09-09T23:30:00.000Z"), "Asia/Tokyo"),
    ).toBe("2026-09-10 08:30")
    expect(formatTimestamp(new Date("2026-01-05T00:07:00.000Z"))).toBe(
      "2026-01-05 00:07",
    )
  })
  test("falls back to UTC for a timezone ICU does not know", () => {
    expect(formatTimestamp(date, "Mars/Olympus_Mons")).toBe(at)
  })
})

describe("unit: sheets client", () => {
  test("passes config to the sheet opener", async () => {
    const h = harness()
    await h.client.upsertEmail("a@b.com")
    expect(h.opened).toEqual([config])
  })
  test("creates a blank sheet's header and checkboxes once, then appends", async () => {
    const h = harness({})
    expect(await h.client.upsertEmail("a@b.com")).toEqual({
      outcome: "inserted",
      headerCreated: true,
    })
    expect(h.headers()).toEqual([...COLUMNS])
    expect(h.calls.setHeaderRow).toEqual([[...COLUMNS]])
    expect(h.calls.setDataValidation).toEqual([checkbox])
    expect(h.calls.addRow).toEqual([
      {
        values: { email: "a@b.com", first_seen_at: at, last_seen_at: at },
        options: { raw: true },
      },
    ])
    expect(h.rows).toEqual([
      { email: "a@b.com", first_seen_at: at, last_seen_at: at, contacted: "" },
    ])
    await h.client.upsertEmail("a@b.com")
    expect(h.calls.setHeaderRow).toHaveLength(1)
    expect(h.calls.setDataValidation).toHaveLength(1)
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
    expect(h.calls.setHeaderRow).toEqual([[...COLUMNS]])
    expect(h.calls.addRow).toHaveLength(1)
  })
  test("appends once without touching an existing header", async () => {
    const h = harness()
    expect(await h.client.upsertEmail("a@b.com")).toEqual({
      outcome: "inserted",
      headerCreated: false,
    })
    expect(h.calls.setHeaderRow).toEqual([])
    expect(h.calls.setDataValidation).toEqual([])
    expect(h.calls.addRow).toHaveLength(1)
    expect(h.calls.loadHeaderRow).toBe(1)
    expect(h.calls.getRows).toBe(1)
  })
  for (const email of ["a@b.com", "  A@B.COM "]) {
    test(`updates only the last_seen_at cell for ${JSON.stringify(email)}`, async () => {
      const original = {
        email,
        first_seen_at: "original",
        last_seen_at: "old",
        contacted: "TRUE",
      }
      const h = harness({ headers: [...COLUMNS], rows: [original] })
      expect(await h.client.upsertEmail("a@b.com")).toEqual({
        outcome: "updated",
        headerCreated: false,
      })
      expect(h.rows).toEqual([{ ...original, last_seen_at: at }])
      expect(h.calls.loadCells).toEqual(["C2"])
      expect(h.calls.saveUpdatedCells).toEqual([[{ address: "C2", value: at }]])
      expect(h.calls.addRow).toEqual([])
    })
  }
  test("writes timestamps in the spreadsheet's timezone", async () => {
    const local = "2026-09-09 11:00"
    const h = harness(
      { headers: [...COLUMNS], rows: [{ email: "a@b.com" }] },
      { timeZone: "Europe/London" },
    )
    await h.client.upsertEmail("a@b.com")
    await h.client.upsertEmail("c@d.com")
    expect(h.calls.saveUpdatedCells).toEqual([
      [{ address: "C2", value: local }],
    ])
    expect(h.calls.addRow[0].values).toEqual({
      email: "c@d.com",
      first_seen_at: local,
      last_seen_at: local,
    })
  })
  test("accepts extra columns, another order, and no contacted column", async () => {
    const h = harness({
      headers: ["note", "last_seen_at", "email", "first_seen_at"],
      rows: [{ note: "keep", last_seen_at: "old", email: "a@b.com" }],
    })
    await h.client.upsertEmail("a@b.com")
    await h.client.upsertEmail("c@d.com")
    expect(h.rows).toEqual([
      { note: "keep", last_seen_at: at, email: "a@b.com" },
      { note: "", last_seen_at: at, email: "c@d.com", first_seen_at: at },
    ])
    expect(h.calls.loadCells).toEqual(["B2"])
    expect(h.calls.setHeaderRow).toEqual([])
  })
  test("addresses columns beyond Z", async () => {
    const filler = Array.from({ length: 26 }, (_, i) => `c${i}`)
    const h = harness({
      headers: [...filler, "email", "last_seen_at", "first_seen_at"],
      rows: [{ email: "a@b.com" }],
    })
    await h.client.upsertEmail("a@b.com")
    expect(h.calls.loadCells).toEqual(["AB2"])
    expect(h.rows[0].last_seen_at).toBe(at)
  })
  for (const missing of written) {
    test(`rejects a missing ${missing} column without writing`, async () => {
      const h = harness({ headers: COLUMNS.filter((key) => key !== missing) })
      await expect(h.client.upsertEmail("a@b.com")).rejects.toThrow(missing)
      noWrites(h.calls)
      expect(h.calls.getRows).toBe(0)
    })
  }
  test("reports all missing columns and the expected header", async () => {
    const h = harness({ headers: ["note"] })
    await expect(h.client.upsertEmail("a@b.com")).rejects.toThrow(
      "Missing worksheet columns: email, first_seen_at, last_seen_at. Expected: email, first_seen_at, last_seen_at, contacted",
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
  for (const method of [
    "setHeaderRow",
    "setDataValidation",
    "getRows",
    "addRow",
    "loadCells",
    "saveUpdatedCells",
  ] as const) {
    test(`propagates ${method} failures`, async () => {
      const error = new Error(`${method} failed`)
      const blank = method === "setHeaderRow" || method === "setDataValidation"
      const h = harness({
        headers: blank ? undefined : [...COLUMNS],
        rows: method.endsWith("Cells") ? [{ email: "a@b.com" }] : [],
        fail: { [method]: error },
      })
      await expect(h.client.upsertEmail("a@b.com")).rejects.toBe(error)
    })
  }
})
