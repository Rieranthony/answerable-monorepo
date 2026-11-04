import { onCleanup } from "./cleanup"

/** One email a fake Postmark accepted: the fields of Postmark's email call that ID sets, and when it arrived. */
export type FakeMail = {
  /** The `MessageID` the fake answered with. */
  id: string
  from: string
  to: string
  replyTo: string | null
  subject: string
  html: string
  text: string
  tag: string | null
  /** `TrackOpens` and `TrackLinks` as sent: ID sends `false` and `None`. */
  tracking: { opens: unknown; links: unknown }
  receivedAt: number
}

/**
 * A fake Postmark, for a test or the kind stack. It answers Postmark's email call at `POST /email` the way Postmark does:
 * `401` with `ErrorCode` 10 unless the `X-Postmark-Server-Token` header is `token`; `422` with 300 for a body that is not JSON or
 * lacks `From`, `To`, `Subject` or a body; `422` with 406 (inactive recipient) for an address whose local part is `inactive`;
 * otherwise `200`, `ErrorCode` 0 and a `MessageID`, keeping the message. Another request reads what it kept: `GET /fake/messages`
 * with the token header lists them as JSON, `?to=` keeping one recipient's, so that a process that cannot reach this one's memory
 * (a browser's driver) can read a mail. Point ID at it with `POSTMARK_API_URL`, `POSTMARK_SERVER_TOKEN` being `token`. With `tls`
 * it serves https, which production requires of that URL.
 */
export function startFakePostmark({
  token,
  hostname = "127.0.0.1",
  port = 0,
  tls,
}: {
  token: string
  hostname?: string
  port?: number
  tls?: { cert: string; key: string }
}) {
  const kept: FakeMail[] = []
  const server = Bun.serve({
    hostname,
    port,
    tls,
    async fetch(request) {
      const url = new URL(request.url)
      if (request.headers.get("x-postmark-server-token") !== token) {
        return Response.json({ ErrorCode: 10, Message: "Bad or missing Server API token." }, { status: 401 })
      }
      if (request.method === "GET" && url.pathname === "/fake/messages") {
        const to = url.searchParams.get("to")
        return Response.json(kept.filter((mail) => to === null || mail.to === to))
      }
      if (request.method !== "POST" || url.pathname !== "/email") return new Response("Not found", { status: 404 })
      const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
      const field = (name: string) => (typeof body?.[name] === "string" ? (body[name] as string) : null)
      const [from, to, subject, html, text] = ["From", "To", "Subject", "HtmlBody", "TextBody"].map(field)
      if (!from || !to || !subject || (!html && !text)) {
        return Response.json({ ErrorCode: 300, Message: "Invalid email request" }, { status: 422 })
      }
      if (to.split("@")[0] === "inactive") {
        return Response.json({ ErrorCode: 406, Message: "You tried to send to a recipient that has been marked as inactive." }, { status: 422 })
      }
      const id = crypto.randomUUID()
      kept.push({
        id,
        from,
        to,
        replyTo: field("ReplyTo"),
        subject,
        html: html ?? "",
        text: text ?? "",
        tag: field("Tag"),
        tracking: { opens: body?.TrackOpens, links: body?.TrackLinks },
        receivedAt: Date.now(),
      })
      return Response.json({ To: to, SubmittedAt: new Date().toISOString(), MessageID: id, ErrorCode: 0, Message: "OK" })
    },
  })
  const stop = () => server.stop(true)
  onCleanup(stop)
  const origin = `${tls ? "https" : "http"}://${hostname}:${server.port}`
  return {
    /** What `POSTMARK_API_URL` is: the email call. */
    url: `${origin}/email`,
    /** Where `messages` reads from, for a process of its own. */
    inbox: `${origin}/fake/messages`,
    /** Every email kept so far, oldest first. */
    messages: (): readonly FakeMail[] => kept,
    /**
     * The first email to `to` that arrived after `after` (a `receivedAt`, default none), waiting up to `timeoutMs`: ID sends after it answers the
     * request, so a test waits. Throws when none comes.
     */
    async waitFor(to: string, { after = 0, timeoutMs = 20_000 }: { after?: number; timeoutMs?: number } = {}) {
      for (const deadline = Date.now() + timeoutMs; Date.now() < deadline; await Bun.sleep(100)) {
        const found = kept.find((mail) => mail.to === to && mail.receivedAt > after)
        if (found) return found
      }
      throw new Error(`No email to ${to} reached the fake Postmark within ${timeoutMs / 1000} s; it holds ${kept.length}`)
    },
    stop,
  }
}

/** The sign-in link and the 8-digit code in an email's text part, as `magic-link` and `mailbox-code` write them: the code alone on its line. */
export function readMail(mail: Pick<FakeMail, "text">) {
  return {
    link: /https?:\/\/\S+/.exec(mail.text)?.[0] ?? null,
    code: /^\d{8}$/m.exec(mail.text)?.[0] ?? null,
  }
}
