import {
  AttioError,
  createAttioClient,
  parseAttioConfig,
  type AttioDeps,
} from "./attio"

export type WaitlistState =
  | { status: "idle" }
  | { status: "error"; message: string }
  | { status: "success"; email: string }

export const MESSAGES = {
  empty: "Please enter your email address.",
  invalid: "That doesn't look like a valid email address.",
  failed: "Something went wrong on our side. Please try again in a moment.",
} as const

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const EMAIL_MAX_LENGTH = 254

export type WaitlistDeps = AttioDeps & {
  /** Defaults to process.env, read at call time so builds never need it. */
  env?: Record<string, string | undefined>
  log?: Pick<Console, "error" | "warn" | "info">
}

/**
 * Validates the address and saves it to Attio. Without an API key it only
 * logs the signup outside production, so the form stays usable in development.
 */
export async function submitWaitlist(
  rawEmail: string,
  deps: WaitlistDeps = {},
): Promise<WaitlistState> {
  const env = deps.env ?? process.env
  const log = deps.log ?? console
  const email = rawEmail.trim().toLowerCase()

  if (!email) return { status: "error", message: MESSAGES.empty }
  if (email.length > EMAIL_MAX_LENGTH || !EMAIL_PATTERN.test(email)) {
    return { status: "error", message: MESSAGES.invalid }
  }

  const config = parseAttioConfig(env)
  if (!config) {
    if (env.NODE_ENV === "production") {
      log.error("[waitlist] attio_not_configured", { email })
      return { status: "error", message: MESSAGES.failed }
    }
    log.info("[waitlist] attio_not_configured, signup logged only", { email })
    return { status: "success", email }
  }

  const attio = createAttioClient(config, deps)
  try {
    const result = await attio.addToWaitlist({ email })
    if (!result.listed && result.listError) {
      log.error(
        "[waitlist] attio_list_entry_failed",
        describe(result.listError, email),
      )
    }
    return { status: "success", email }
  } catch (error) {
    if (error instanceof AttioError) {
      if (error.kind === "invalid_input") {
        log.warn("[waitlist] attio_rejected_email", describe(error, email))
        return { status: "error", message: MESSAGES.invalid }
      }
      if (error.kind === "multiple_matches") {
        // Duplicate people already exist for this address, so the signup is
        // known. Merge them in Attio before the list step can succeed.
        log.warn("[waitlist] attio_multiple_matches", describe(error, email))
        return { status: "success", email }
      }
      log.error("[waitlist] attio_failed", describe(error, email))
    } else {
      log.error("[waitlist] attio_failed", {
        email,
        message: error instanceof Error ? error.message : String(error),
      })
    }
    return { status: "error", message: MESSAGES.failed }
  }
}

function describe(error: AttioError, email: string) {
  return {
    email,
    kind: error.kind,
    status: error.status,
    code: error.code,
    message: error.message,
  }
}
