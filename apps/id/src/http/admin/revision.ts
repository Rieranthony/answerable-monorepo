import { z } from "zod";
import { ProblemError } from "../problem.ts";

export type Revision = { id: string; revision: number };
export const revisionSchema = z.object({
  id: z.uuid(),
  revision: z.number().int().positive(),
});
/** Refuse a command whose precondition no longer holds: an If-Match revision,
 * or null for If-None-Match: *, which requires the target to be absent.
 * Undefined, no precondition, checks nothing. */
export function assertRevision(
  current: Revision | null,
  expected: Revision | null | undefined,
  title: string,
) {
  if (expected === undefined) return;
  if (
    expected === null
      ? current !== null
      : current?.id !== expected.id || current.revision !== expected.revision
  )
    throw new ProblemError(412, "revision_mismatch", title);
}
export const revisionTag = (value: Revision): string =>
  `"${value.id}:${value.revision}"`;

/** Read If-Match: one revision tag, as ID sent it or marked weak (W/). A proxy
 * that compresses the response, as Cloudflare does, makes the tag weak on its
 * way to the client, but the revision still names the exact state, so the weak
 * copy matches too. RFC 9110 compares If-Match strongly; ID departs from it here
 * on purpose, for its own tags only. */
export function requireRevision(
  header: string | undefined,
): Revision | undefined {
  if (header === undefined) return undefined;
  const match = /^(?:W\/)?"([^:]+):([1-9][0-9]*)"$/.exec(header);
  const id = z.uuid().safeParse(match?.[1]);
  const revision = Number(match?.[2]);
  if (!id.success || !Number.isSafeInteger(revision))
    throw new ProblemError(
      400,
      "invalid_revision",
      "Supply one revision ETag in If-Match",
    );
  return { id: id.data, revision };
}

export const revisionParameter = {
  in: "header" as const,
  name: "If-Match",
  required: false,
  schema: { type: "string" as const },
  description:
    "The ETag returned by the target GET route, as sent or marked weak (W/) by a proxy on the way: both name the same revision. Reuse the original tag when retrying the same operation.",
};
export const revisionResponseHeaders = {
  ETag: {
    schema: { type: "string" as const },
    description:
      "Entity instance and configuration revision, for the next If-Match",
  },
};

export function requirePutRevision(
  ifMatch: string | undefined,
  ifNoneMatch: string | undefined,
): Revision | null | undefined {
  if (
    ifNoneMatch !== undefined &&
    (ifNoneMatch !== "*" || ifMatch !== undefined)
  )
    throw new ProblemError(
      400,
      "invalid_revision",
      "Supply exactly one supported precondition",
    );
  return ifNoneMatch !== undefined ? null : requireRevision(ifMatch);
}
