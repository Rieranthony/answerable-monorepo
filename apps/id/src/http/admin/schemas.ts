import { resolver } from "hono-openapi";
import { z } from "zod";
import type { AdminRoute } from "./route-table.ts";
export const json = (schema: z.ZodType) => ({
  "application/json": { schema: resolver(schema) },
});
export const operationReceiptSchema = z.object({
  operationId: z.uuid(),
  outcome: z.enum(["applied", "noop"]),
  statusCode: z.number().int(),
  resultReference: z.object({ type: z.string(), id: z.string() }),
});
export const commandJson = (schema: z.ZodType) =>
  json(z.union([schema, operationReceiptSchema]));
export const body = (schema: z.ZodType) =>
  ({
    required: true,
    content: { "application/json": { schema: z.toJSONSchema(schema) } },
  }) as AdminRoute["requestBody"];
export const pathParameter = (name: string, format?: string) => ({
  in: "path" as const,
  name,
  required: true,
  schema: { type: "string" as const, ...(format ? { format } : {}) },
  ...(name === "resource"
    ? { description: "The resource URL, percent-encoded in the path." }
    : {}),
});
export const uuidParam = <Name extends string>(name: Name) =>
  z.object({ [name]: z.uuid() } as Record<Name, z.ZodUUID>);
export const confirmQuery = (schema: z.ZodType) =>
  ({
    in: "query" as const,
    name: "confirm",
    required: true,
    schema: z.toJSONSchema(schema),
    description: "Must equal the target id.",
  }) as NonNullable<AdminRoute["parameters"]>[number];
export const windowSchema = z.object({
  validFrom: z.iso.datetime().nullable().optional(),
  validUntil: z.iso.datetime().nullable().optional(),
});
export function windowDates(input: z.output<typeof windowSchema>) {
  return {
    validFrom:
      input.validFrom === undefined
        ? undefined
        : input.validFrom === null
          ? null
          : new Date(input.validFrom),
    validUntil:
      input.validUntil === undefined
        ? undefined
        : input.validUntil === null
          ? null
          : new Date(input.validUntil),
  };
}
