import type { z } from "zod"

/** A failure the admin API answers as `{ error: { code, message } }` with `status`. */
export class Problem extends Error {
  constructor(readonly status: 400 | 401 | 403 | 404 | 409 | 422 | 500 | 502, readonly code: string, message: string) {
    super(message)
  }
}

/** Parse a request body against `schema`, or answer 400 naming each field to fix. */
export function parse<T extends z.ZodType>(schema: T, body: unknown): z.output<T> {
  const parsed = schema.safeParse(body)
  if (!parsed.success) throw new Problem(400, "invalid_request", parsed.error.issues.map(({ path, message }) => `${path.join(".") || "body"}: ${message}`).join("; "))
  return parsed.data
}
