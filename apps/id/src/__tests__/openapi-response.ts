import { readFileSync } from "node:fs";
import { z } from "zod";

type Operation = {
  operationId?: string;
  responses?: Record<
    string,
    { content?: Record<string, { schema?: Record<string, unknown> }> }
  >;
};
const document = JSON.parse(
  readFileSync(new URL("../../openapi.admin.json", import.meta.url), "utf8"),
) as { paths: Record<string, Record<string, Operation>> };

/** The published JSON response schema of an admin operation, so tests check
 * bodies against the contract consumers read rather than internal schemas. */
export function responseSchema(operationId: string, status: number) {
  const operation = Object.values(document.paths)
    .flatMap((methods) => Object.values(methods))
    .find((candidate) => candidate.operationId === operationId);
  const schema =
    operation?.responses?.[status]?.content?.["application/json"]?.schema;
  if (!schema) throw new Error(`No ${status} JSON for ${operationId}`);
  const parser = z.fromJSONSchema(schema);
  return {
    parse: (body: unknown): Awaited<ReturnType<Response["json"]>> =>
      parser.parse(body),
  };
}
