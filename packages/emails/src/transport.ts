// Sending: a thin fetch client for Postmark, and the shape every transport has. No `postmark` package: one endpoint,
// our own timeout and our own retry rule are all it would add to.
import type { RenderedEmail } from "./render"

/** One email to send: `renderEmail`'s output and the address it goes to. */
export type Message = RenderedEmail & {
  /** One address, which the caller has parsed: Postmark's `To` takes a comma-separated list, and a sign-in link must go to one person. */
  to: string
}

/**
 * What a send came to. Postmark's answer never throws: a refusal, a timeout and a network error are `failed`. A failed
 * result carries numbers and a flag only: never the token, the link, the code, the address or Postmark's message, which
 * can repeat the address.
 */
export type SendResult =
  | {
      status: "sent"
      /** Postmark's id for the message: what its Activity page and its webhooks name it by. */
      messageId: string
    }
  | {
      status: "failed"
      /** The HTTP status Postmark answered, or `null` when none arrived (a network error or the timeout). */
      httpStatus: number | null
      /** Postmark's `ErrorCode`, or `null` when there was no answer to read. */
      errorCode: number | null
      /** Whether a second attempt was made: the result is the second attempt's. */
      retried: boolean
    }

/** Anything that sends an email: Postmark, a log line for local development, or memory for a test. */
export type Transport = {
  send(message: Message): Promise<SendResult>
}

/** What `createPostmarkTransport` takes. */
export type PostmarkTransportOptions = {
  /** The Server API token. It leaves only in the `X-Postmark-Server-Token` header. */
  serverToken: string
  /** The sender, as Postmark takes it: `Answerable ID <sign-in@id.answerable.org>`. */
  from: string
  /** Where replies go. */
  replyTo: string
  /** Put before every subject with a space, for an environment that must not read as production: `[staging]`. */
  subjectPrefix?: string
  /**
   * Where the email call goes. Default Postmark's own, `https://api.postmarkapp.com/email`. For a fake Postmark that a
   * test or the kind stack runs: it receives the server token, so a real deployment must never set it to anything but
   * `https:`.
   */
  endpoint?: string
  /** Replaces the global `fetch`, for a test. */
  fetch?: (input: string, init: RequestInit) => Promise<Response>
  /** How long one attempt may take, answer included. Default 10 seconds. */
  timeoutMs?: number
  /** How long to wait before the one retry. Default 1 second. */
  retryDelayMs?: number
}

/** Postmark's email call: what `endpoint` defaults to. */
const ENDPOINT = "https://api.postmarkapp.com/email"

type Attempt =
  | { sent: true; messageId: string }
  | { sent: false; httpStatus: number | null; errorCode: number | null }

/**
 * Sends through Postmark's email API with `TrackOpens` off and `TrackLinks` `None` (a tracked link would send the person
 * through Postmark's redirect), an `Auto-Submitted` header and no `Metadata`: nothing secret goes in `Tag` or `Metadata`.
 *
 * One retry, after `retryDelayMs`, on a 429, a 5xx, a network error or a timeout; never on any other answer, a 4xx
 * included. Postmark has no idempotency key, so a retried timeout can in theory send the email twice: both links are
 * valid and the person uses one.
 */
export function createPostmarkTransport({
  serverToken,
  from,
  replyTo,
  subjectPrefix,
  endpoint = ENDPOINT,
  fetch: send = fetch,
  timeoutMs = 10_000,
  retryDelayMs = 1_000,
}: PostmarkTransportOptions): Transport {
  const attempt = async (body: string): Promise<Attempt> => {
    try {
      const response = await send(endpoint, {
        method: "POST",
        headers: {
          "X-Postmark-Server-Token": serverToken,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      })
      const answer: unknown = await response.json().catch(() => null)
      const { ErrorCode: errorCode, MessageID: messageId } = (answer ??
        {}) as Record<string, unknown>
      // A 2xx whose answer cannot be read has no message id. It is reported as failed and never retried: Postmark may
      // well have sent it.
      if (
        response.ok &&
        errorCode === 0 &&
        typeof messageId === "string" &&
        messageId !== ""
      ) {
        return { sent: true, messageId }
      }
      return {
        sent: false,
        httpStatus: response.status,
        errorCode: typeof errorCode === "number" ? errorCode : null,
      }
    } catch {
      // A network error, the timeout or an unreadable body. Not the error itself: it can carry the request.
      return { sent: false, httpStatus: null, errorCode: null }
    }
  }

  return {
    async send({ to, subject, html, text, tag }) {
      const body = JSON.stringify({
        From: from,
        To: to,
        ReplyTo: replyTo,
        Subject: subjectPrefix ? `${subjectPrefix} ${subject}` : subject,
        HtmlBody: html,
        TextBody: text,
        Tag: tag,
        MessageStream: "outbound",
        TrackOpens: false,
        TrackLinks: "None",
        Headers: [
          { Name: "Auto-Submitted", Value: "auto-generated" },
          { Name: "X-Auto-Response-Suppress", Value: "All" },
        ],
      })
      let result = await attempt(body)
      let retried = false
      if (!result.sent && retryable(result.httpStatus)) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs))
        result = await attempt(body)
        retried = true
      }
      return result.sent
        ? { status: "sent", messageId: result.messageId }
        : {
            status: "failed",
            httpStatus: result.httpStatus,
            errorCode: result.errorCode,
            retried,
          }
    },
  }
}

// No answer at all (a network error or the timeout), the rate limit and Postmark's own faults.
const retryable = (httpStatus: number | null) =>
  httpStatus === null || httpStatus === 429 || httpStatus >= 500

/**
 * A transport for local development: writes the recipient, the subject and the text part, link and code included, to
 * `log` and sends nothing, so a developer can follow the link. Never for production: the text holds a working link.
 */
export function createLogTransport(log: (line: string) => void): Transport {
  return {
    async send({ to, subject, text }) {
      log(`Email to ${to}: ${subject}\n\n${text}\n`)
      return { status: "sent", messageId: "local" }
    },
  }
}
