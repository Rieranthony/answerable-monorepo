# Answerable emails

Every email Answerable sends, and the Postmark transport that sends it. Private to the monorepo; no npm release.

```ts
import { createPostmarkTransport, renderEmail } from "@answerable/emails"

const transport = createPostmarkTransport({
  serverToken: process.env.POSTMARK_SERVER_TOKEN!,
  from: "Answerable ID <sign-in@id.answerable.org>",
  replyTo: "info@answerable.org",
})

const email = renderEmail({
  template: "magic-link",
  firmName: "Acme Surveyors",
  url: "https://id.answerable.org/magic-link?token=…",
  code: "04817352",
  expiresInMinutes: 30,
})
const result = await transport.send({ to: "alice@acme.example", ...email })
// { status: "sent", messageId } or { status: "failed", httpStatus, errorCode, retried }: never a throw for Postmark's answer
```

| Email | Subject | Tag | Holes |
| --- | --- | --- | --- |
| `magic-link` | Sign in to {firmName} | `sign-in` | `firmName`, `url`, `code`, `expiresInMinutes` |
| `mailbox-code` | Your code to connect your company sign-in | `mailbox-code` | `firmName`, `code`, `expiresInMinutes` |

`renderEmail` is synchronous. It refuses an empty firm name, by throwing a `TypeError`. A line break in a firm name becomes a space. The caller makes the address, the code and the expiry itself, and they are not checked again. Every value is escaped in the HTML part and used as given in the subject and the text part.

## Transport

- `createPostmarkTransport` is a thin `fetch` client: a 10 second timeout, one retry after `retryDelayMs` on a 429, a 5xx, a network error or a timeout, and none on any other answer. `TrackOpens` is off and `TrackLinks` is `None`; no `Metadata`, and nothing secret in `Tag`. Postmark has no idempotency key, so a retried timeout can send an email twice.
- `endpoint` replaces Postmark's address (`https://api.postmarkapp.com/email`) with a fake Postmark's, for a test or the kind stack. The server token goes in that request, so a deployment must never set it to anything but `https:`: Answerable ID's `POSTMARK_API_URL` refuses plain `http:` in production.
- A failed result holds numbers and a flag only: never the token, the link, the code, the address or Postmark's message. `errorCode` 406 means Postmark suppressed the address; 412 and 413 mean the account is not approved yet.
- `createLogTransport(log)` writes the recipient, subject and text, link and code included, for local development. `createMemoryTransport()` from `@answerable/emails/testing` keeps what it was sent, and fails when its `failure` is set.

## Add an email

1. Write `src/<name>.tsx`: the first line is `/** @jsxImportSource react */`, the content goes in `Layout` from `src/layout.tsx`, and every value arrives as a string prop (`{firmName}`, `{expiry}`).
2. Add it to the `Email` type and `holeNames` in `src/holes.ts` (its checks go in `holesOf`), and to the table in `src/react.tsx` with its subject and tag.
3. `bun run --filter @answerable/emails generate`, and commit `src/generated/templates.generated.ts`.
4. Add it to `emails` in `src/fixtures.ts` and read its text in `src/render.test.ts`.

## Preview

`bun run --filter @answerable/emails preview [directory]` writes each email's HTML and text to `dist/preview/` (git-ignored), from the generated strings, so an edit shows after a `generate`. The firm name is hostile on purpose: the files show the escaping. Open them in a browser, or send them to a test inbox.

## Why the emails are precompiled

React Email renders in about 20 ms and, measured under Bun 1.3.1, keeps about 20 KB of heap per render. Bundled into a service it adds 1.36 MB (React, `react-dom`, Prettier, an HTML-to-text converter). Each email's only holes are strings, so `scripts/generate.ts` renders each template once with `{{hole}}` placeholders and commits the result. `renderEmail` fills the holes in one pass, with no React: the entry bundles to about 28 KB.

- **A test holds the generated file to the templates.** `src/generate.test.ts` fails when the committed file differs from what the generator writes, and names the command to run. `src/render.test.ts` reads each email's text, and fills it with hostile values.
- **No React reaches a service.** `src/index.ts` and `src/testing.ts` import none, and `src/bundle.test.ts` bundles the entry and looks for it. React Email, React and the generator are `devDependencies`; `src/react.tsx` is not in the package's exports.
- **Each `.tsx` carries its own JSX pragma.** A consumer whose tsconfig says another runtime (Answerable ID uses `hono/jsx`) would otherwise type-check and run these files with its own.
- **Limits.** Holes are strings. A repeated or optional block needs a variant of the template, or a different approach.
