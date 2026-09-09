// Shared in-memory worksheet for the sheets and waitlist unit tests.
import type { Row, Worksheet } from "./sheets"

type Method = "loadHeaderRow" | "setHeaderRow" | "getRows" | "addRow" | "save"

export function fakeWorksheet(
  initial: {
    headers?: string[]
    rows?: Record<string, string>[]
    fail?: Partial<Record<Method, unknown>>
  } = {},
) {
  let headers = initial.headers ? [...initial.headers] : undefined
  let loaded = false
  const rows = (initial.rows ?? []).map((row) => ({ ...row }))
  const calls = {
    loadHeaderRow: 0,
    getRows: 0,
    setHeaderRow: [] as string[][],
    addRow: [] as {
      values: Record<string, string>
      options?: { raw?: boolean }
    }[],
    save: [] as { row: Record<string, string>; options?: { raw?: boolean } }[],
  }
  function fail(method: Method) {
    if (initial.fail && method in initial.fail) throw initial.fail[method]
  }
  const worksheet: Worksheet = {
    async loadHeaderRow() {
      calls.loadHeaderRow++
      fail("loadHeaderRow")
      if (!headers)
        throw new Error(
          "No values in the header row - fill the first row with header values before trying to interact with rows",
        )
      loaded = true
    },
    async setHeaderRow(values) {
      calls.setHeaderRow.push([...values])
      fail("setHeaderRow")
      headers = [...values]
      loaded = true
    },
    get headerValues() {
      if (!loaded) throw new Error("Header values are not yet loaded")
      return headers!
    },
    async getRows() {
      calls.getRows++
      fail("getRows")
      return rows.map((row): Row => ({
        get: (key) => row[key],
        set: (key, value) => {
          row[key] = value
        },
        async save(options) {
          calls.save.push({ row: { ...row }, options })
          fail("save")
        },
      }))
    },
    async addRow(values, options) {
      calls.addRow.push({ values: { ...values }, options })
      fail("addRow")
      rows.push(
        Object.fromEntries(
          worksheet.headerValues.map((key) => [key, values[key] ?? ""]),
        ),
      )
    },
  }
  return { worksheet, rows, headers: () => headers, calls }
}
