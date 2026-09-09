// Thin client for Google Sheets.
// Kept pure on purpose: no environment access, and the worksheet is injectable,
// so tests never touch the network.
// Deliberately no `import "server-only"`: Next resolves that import itself,
// but Bun cannot in tests. The only importer is lib/waitlist.ts, which is
// reached solely from the "use server" module app/actions.ts.
import { JWT } from "google-auth-library"
import { GoogleSpreadsheet } from "google-spreadsheet"

const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"]

/** Row 1 as the client writes it on a blank sheet. */
export const COLUMNS = [
  "email",
  "first_seen_at",
  "last_seen_at",
  "contacted",
] as const
/** The columns the client writes; the rest belong to whoever reads the sheet. */
const WRITTEN = ["email", "first_seen_at", "last_seen_at"] as const
const CONTACTED = COLUMNS.indexOf("contacted")

export type SheetsConfig = {
  spreadsheetId: string
  clientEmail: string
  /** PEM with real newlines; parseSheetsConfig normalises a literal "\n". */
  privateKey: string
}

/** Returns undefined unless all three variables are set. */
export function parseSheetsConfig(
  source: Record<string, string | undefined>,
): SheetsConfig | undefined {
  const spreadsheetId = source.GOOGLE_SHEETS_ID?.trim()
  const clientEmail = source.GOOGLE_SERVICE_ACCOUNT_EMAIL?.trim()
  const privateKey = source.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY?.trim().replace(
    /\\n/g,
    "\n",
  )
  if (!spreadsheetId || !clientEmail || !privateKey?.trim()) return undefined
  return { spreadsheetId, clientEmail, privateKey }
}

/** The slice of GoogleSpreadsheetRow the upsert needs. */
export type Row = {
  get(key: string): unknown
  /** 1-based, so row 2 is the first one below the header. */
  readonly rowNumber: number
}

/** The slice of GoogleSpreadsheetCell the upsert needs. */
export type Cell = { value: unknown }

export type GridRange = {
  startRowIndex?: number
  endRowIndex?: number
  startColumnIndex?: number
  endColumnIndex?: number
}

export type ValidationRule = {
  condition: { type: "BOOLEAN"; values: never[] }
  strict: boolean
  showCustomUi: boolean
}

/** The slice of GoogleSpreadsheetWorksheet the upsert needs. */
export type Worksheet = {
  loadHeaderRow(): Promise<void>
  setHeaderRow(headers: string[]): Promise<void>
  readonly headerValues: string[]
  getRows(): Promise<Row[]>
  addRow(
    values: Record<string, string>,
    options?: { raw?: boolean },
  ): Promise<unknown>
  loadCells(range: string): Promise<void>
  getCellByA1(address: string): Cell
  saveUpdatedCells(): Promise<void>
  setDataValidation(range: GridRange, rule: ValidationRule): Promise<unknown>
}

export type OpenedSheet = {
  sheet: Worksheet
  /** IANA name from the spreadsheet's settings; timestamps are written in it. */
  timeZone?: string
}

export type SheetsDeps = {
  /**
   * Defaults to the spreadsheet's first worksheet, opened with a
   * service-account JWT.
   */
  openSheet?: (config: SheetsConfig) => Promise<OpenedSheet>
  now?: () => Date
}

export type UpsertResult = {
  outcome: "inserted" | "updated"
  headerCreated: boolean
}

export function createSheetsClient(
  config: SheetsConfig,
  deps: SheetsDeps = {},
): {
  upsertEmail(email: string): Promise<UpsertResult>
} {
  const openSheet = deps.openSheet ?? openGoogleSheet
  const now = deps.now ?? (() => new Date())
  return {
    async upsertEmail(email) {
      const { sheet, timeZone } = await openSheet(config)
      const headerCreated = await ensureHeader(sheet)
      const at = formatTimestamp(now(), timeZone)
      const rows = await sheet.getRows()
      const existing = rows.find(
        (row) =>
          String(row.get("email") ?? "")
            .trim()
            .toLowerCase() === email,
      )
      if (existing) {
        // One cell, not the whole row: saving the row would rewrite the
        // reader's own edits (the contacted checkbox, extra columns) as text.
        const column = columnLetter(sheet.headerValues.indexOf("last_seen_at"))
        const address = `${column}${existing.rowNumber}`
        await sheet.loadCells(address)
        sheet.getCellByA1(address).value = at
        await sheet.saveUpdatedCells()
        return { outcome: "updated", headerCreated }
      }
      await sheet.addRow(
        { email, first_seen_at: at, last_seen_at: at },
        { raw: true },
      )
      return { outcome: "inserted", headerCreated }
    },
  }
}

// google-spreadsheet throws exactly these two messages when row 1 is empty.
// Anything else (auth, network, quota) must never lead to a header write,
// because setHeaderRow overwrites the whole first row.
const EMPTY_HEADER =
  /^(No values in the header row|All your header cells are blank)/

/** Writes row 1 and the contacted checkboxes on a blank sheet. */
async function ensureHeader(sheet: Worksheet): Promise<boolean> {
  try {
    await sheet.loadHeaderRow()
  } catch (error) {
    if (!(error instanceof Error && EMPTY_HEADER.test(error.message))) {
      throw error
    }
    await sheet.setHeaderRow([...COLUMNS])
    await sheet.setDataValidation(
      {
        startRowIndex: 1,
        startColumnIndex: CONTACTED,
        endColumnIndex: CONTACTED + 1,
      },
      {
        condition: { type: "BOOLEAN", values: [] },
        strict: true,
        showCustomUi: true,
      },
    )
    return true
  }
  const missing = WRITTEN.filter(
    (column) => !sheet.headerValues.includes(column),
  )
  if (missing.length) {
    throw new Error(
      `Missing worksheet columns: ${missing.join(", ")}. Expected: ${COLUMNS.join(", ")}`,
    )
  }
  return false
}

const TIMESTAMP_FORMAT: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
}

/** "2026-09-09 11:00" in the spreadsheet's timezone: readable, still sorts. */
export function formatTimestamp(date: Date, timeZone?: string): string {
  const parts = timestampFormatter(timeZone || "UTC").formatToParts(date)
  const part = (type: Intl.DateTimeFormatPart["type"]) =>
    parts.find((candidate) => candidate.type === type)?.value ?? ""
  return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}`
}

function timestampFormatter(timeZone: string): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat("en-GB", { ...TIMESTAMP_FORMAT, timeZone })
  } catch {
    // Sheets sends IANA names, but not every alias is known to ICU.
    return new Intl.DateTimeFormat("en-GB", {
      ...TIMESTAMP_FORMAT,
      timeZone: "UTC",
    })
  }
}

/** 0 → A, 25 → Z, 26 → AA. */
function columnLetter(index: number): string {
  let letters = ""
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters
  }
  return letters
}

async function openGoogleSheet(config: SheetsConfig): Promise<OpenedSheet> {
  const auth = new JWT({
    email: config.clientEmail,
    key: config.privateKey,
    scopes: SCOPES,
  })
  const doc = new GoogleSpreadsheet(config.spreadsheetId, auth)
  await doc.loadInfo()
  const sheet = doc.sheetsByIndex[0]
  if (!sheet) throw new Error("Google spreadsheet has no worksheet")
  return { sheet, timeZone: doc.timeZone }
}
