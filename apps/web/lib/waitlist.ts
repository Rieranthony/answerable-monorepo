import { findCountry } from "@answerable/countries"
import {
  createSheetsClient,
  parseSheetsConfig,
  type SheetsDeps,
} from "./sheets"

export type WaitlistInput = { email: string; country: string }
export type WaitlistErrors = Partial<Record<"email" | "country", string>>

export type WaitlistState =
  | { status: "idle" }
  | { status: "error"; errors?: WaitlistErrors; message?: string }
  | { status: "success"; email: string }

export const MESSAGES = {
  country: "Please select your country.",
  empty: "Please enter your email address.",
  invalid: "That doesn't look like a valid email address.",
  failed: "Something went wrong on our side. Please try again in a moment.",
} as const

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const EMAIL_MAX_LENGTH = 254
const ERROR_MESSAGE_LIMIT = 500

export type WaitlistDeps = SheetsDeps & {
  /** Defaults to process.env, read at call time so builds never need it. */
  env?: Record<string, string | undefined>
  log?: Pick<Console, "error" | "info">
}

/**
 * Validates the address and saves it to a Google Sheet. Without configuration
 * it only logs the signup outside production, so the form stays usable in
 * development.
 */
export async function submitWaitlist(
  input: WaitlistInput,
  deps: WaitlistDeps = {},
): Promise<WaitlistState> {
  const env = deps.env ?? process.env
  const log = deps.log ?? console
  const email = input.email.trim().toLowerCase()

  const errors: WaitlistErrors = {}
  if (!email) errors.email = MESSAGES.empty
  else if (email.length > EMAIL_MAX_LENGTH || !EMAIL_PATTERN.test(email)) {
    errors.email = MESSAGES.invalid
  }
  const country = findCountry(input.country)
  if (!country) errors.country = MESSAGES.country
  if (Object.keys(errors).length || !country) return { status: "error", errors }

  const config = parseSheetsConfig(env)
  if (!config) {
    if (env.NODE_ENV === "production") {
      log.error(line("sheets_not_configured", { email }))
      return { status: "error", message: MESSAGES.failed }
    }
    log.info(line("sheets_not_configured_signup_logged_only", { email }))
    return { status: "success", email }
  }

  try {
    const result = await createSheetsClient(config, deps).upsert({
      email,
      countryCode: country.code,
      countryName: country.name,
    })
    if (result.headerCreated) log.info(line("sheets_header_created", { email }))
    if (result.columnsAdded.length) {
      log.info(
        line("sheets_header_extended", {
          email,
          columns: result.columnsAdded.join(","),
        }),
      )
    }
    return { status: "success", email }
  } catch (error) {
    log.error(
      line("sheets_failed", {
        email,
        message: describe(error, config.privateKey),
      }),
    )
    return { status: "error", message: MESSAGES.failed }
  }
}

type LogFields = Record<string, string | number | undefined>

/** One line per event, JSON fields, so any log sink keeps the address. */
function line(event: string, fields: LogFields): string {
  return `[waitlist] ${event} ${JSON.stringify(fields)}`
}

function describe(error: unknown, secret: string): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replaceAll(secret, "[redacted]").slice(0, ERROR_MESSAGE_LIMIT)
}
