// Shared in-memory worksheet for the sheets and waitlist unit tests.
import type { Cell, GridRange, Row, ValidationRule, Worksheet } from "./sheets"

type Method =
  | "loadHeaderRow"
  | "setHeaderRow"
  | "getRows"
  | "addRow"
  | "loadCells"
  | "saveUpdatedCells"
  | "setDataValidation"
type Values = Record<string, string>
type SavedCell = { address: string; value: unknown }

export function fakeWorksheet(
  initial: {
    headers?: string[]
    rows?: Values[]
    fail?: Partial<Record<Method, unknown>>
  } = {},
) {
  let headers = initial.headers ? [...initial.headers] : undefined
  let loaded = false
  const rows = (initial.rows ?? []).map((row) => ({ ...row }))
  const pending = new Map<
    string,
    { row: number; key: string; value: unknown }
  >()
  const calls = {
    loadHeaderRow: 0,
    getRows: 0,
    setHeaderRow: [] as string[][],
    addRow: [] as { values: Values; options?: { raw?: boolean } }[],
    loadCells: [] as string[][],
    saveUpdatedCells: [] as SavedCell[][],
    setDataValidation: [] as { range: GridRange; rule: ValidationRule }[],
  }
  function fail(method: Method) {
    if (initial.fail && method in initial.fail) throw initial.fail[method]
  }
  function header(): string[] {
    if (!loaded || !headers) throw new Error("Header values are not yet loaded")
    return headers
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
      return header()
    },
    async getRows() {
      calls.getRows++
      fail("getRows")
      return rows.map((row, index): Row => ({
        get: (key) => row[key],
        rowNumber: index + 2,
      }))
    },
    async addRow(values, options) {
      calls.addRow.push({ values: { ...values }, options })
      fail("addRow")
      const row = Object.fromEntries(
        header().map((key) => [key, values[key] ?? ""]),
      )
      const index = rows.length
      rows.push(row)
      return { get: (key: string) => row[key], rowNumber: index + 2 }
    },
    async loadCells(ranges) {
      calls.loadCells.push([...ranges])
      fail("loadCells")
    },
    getCellByA1(address): Cell {
      const [, letters, digits] = /^([A-Z]+)(\d+)$/.exec(address) ?? []
      if (!letters || !digits) throw new Error(`Bad A1 address ${address}`)
      const column =
        [...letters].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1
      const row = Number(digits) - 2
      const key = header()[column]
      if (!key || !rows[row]) throw new Error(`No cell at ${address}`)
      return {
        get value() {
          return pending.get(address)?.value ?? rows[row][key]
        },
        set value(value) {
          pending.set(address, { row, key, value })
        },
      }
    },
    async saveUpdatedCells() {
      const saved = [...pending].map(([address, cell]) => ({
        address,
        value: cell.value,
      }))
      calls.saveUpdatedCells.push(saved)
      fail("saveUpdatedCells")
      for (const { row, key, value } of pending.values()) {
        rows[row][key] = String(value)
      }
      pending.clear()
    },
    async setDataValidation(range, rule) {
      calls.setDataValidation.push({ range, rule })
      fail("setDataValidation")
    },
  }
  return { worksheet, rows, headers: () => headers, calls }
}
