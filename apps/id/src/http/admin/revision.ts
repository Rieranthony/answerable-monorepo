import { z } from "zod";
import { ProblemError } from "../problem.ts";

export type Revision = { id: string; revision: number };
export const revisionTag = (value: Revision): string =>
  `"${value.id}:${value.revision}"`;

export function requireRevision(header: string | undefined): Revision {
  if (header === undefined)
    throw new ProblemError(
      428,
      "precondition_required",
      "If-Match is required",
    );
  const match = /^"([^:]+):([1-9][0-9]*)"$/.exec(header);
  const id = z.uuid().safeParse(match?.[1]);
  const revision = Number(match?.[2]);
  if (!id.success || !Number.isSafeInteger(revision))
    throw new ProblemError(
      400,
      "invalid_revision",
      "Supply one strong revision ETag in If-Match",
    );
  return { id: id.data, revision };
}

export const revisionParameter = {
  in: "header" as const,
  name: "If-Match",
  required: true,
  schema: { type: "string" as const },
  description:
    "The strong ETag returned by the target GET route. Reuse the original tag when retrying the same operation.",
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
): Revision | null {
  if (ifMatch === undefined && ifNoneMatch === undefined)
    throw new ProblemError(
      428,
      "precondition_required",
      "Supply If-Match for replacement or If-None-Match: * for creation",
    );
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
