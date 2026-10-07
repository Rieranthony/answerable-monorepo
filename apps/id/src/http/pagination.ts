import { z } from "zod";

export const pageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.uuid().optional(),
});

export type PageQuery = z.output<typeof pageQuerySchema>;
