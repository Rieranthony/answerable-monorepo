// Thin client for Google Sheets.
// Kept pure on purpose: no environment access, and the worksheet is injectable,
// so tests never touch the network.
// Deliberately no `import "server-only"`: Next resolves that import itself,
// but Bun cannot in tests. The only importer is lib/waitlist.ts, which is
// reached solely from the "use server" module app/actions.ts.
import { JWT } from "google-auth-library"
import { GoogleSpreadsheet } from "google-spreadsheet"

const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"]
export const HEADERS = ["email", "first_seen_at", "last_seen_at"] as const

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
  set(key: string, value: string): void
  save(options?: { raw?: boolean }): Promise<void>
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
}

export type SheetsDeps = {
  /**
   * Defaults to the spreadsheet's first worksheet, opened with a
   * service-account JWT.
   */
  openWorksheet?: (config: SheetsConfig) => Promise<Worksheet>
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
  const openWorksheet = deps.openWorksheet ?? openGoogleWorksheet
  const now = deps.now ?? (() => new Date())
  return {
    async upsertEmail(email) {
      const sheet = await openWorksheet(config)
      const headerCreated = await ensureHeader(sheet)
      const at = now().toISOString()
      const rows = await sheet.getRows()
      const existing = rows.find(
        (row) =>
          String(row.get("email") ?? "")
            .trim()
            .toLowerCase() === email,
      )
      if (existing) {
        existing.set("last_seen_at", at)
        await existing.save({ raw: true })
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

async function ensureHeader(sheet: Worksheet): Promise<boolean> {
  try {
    await sheet.loadHeaderRow()
  } catch (error) {
    if (
      error instanceof Error &&
      /^(No values in the header row|All your header cells are blank)/.test(
        error.message,
      )
    ) {
      await sheet.setHeaderRow([...HEADERS])
      return true
    }
    throw error
  }
  const missing = HEADERS.filter(
    (header) => !sheet.headerValues.includes(header),
  )
  if (missing.length) {
    throw new Error(
      `Missing worksheet columns: ${missing.join(", ")}. Expected: ${HEADERS.join(", ")}`,
    )
  }
  return false
}

async function openGoogleWorksheet(config: SheetsConfig): Promise<Worksheet> {
  const auth = new JWT({
    email: config.clientEmail,
    key: config.privateKey,
    scopes: SCOPES,
  })
  const doc = new GoogleSpreadsheet(config.spreadsheetId, auth)
  await doc.loadInfo()
  const sheet = doc.sheetsByIndex[0]
  if (!sheet) throw new Error("Google spreadsheet has no worksheet")
  return sheet
}
