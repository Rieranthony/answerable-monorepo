import { z } from "zod"

export const recordSchema = z.object({
  id: z.uuid(),
  organizationId: z.uuid(),
  creatorId: z.uuid(),
  title: z.string().trim().min(1).max(200),
  createdAt: z.string().datetime(),
})
export const createInput = z.object({
  title: z.string().trim().min(1).max(200),
  operationKey: z.uuid(),
}).strict()
export const deleteInput = z.object({ recordId: z.uuid(), operationKey: z.uuid() }).strict()
export const recordsOutput = z.object({ records: z.array(recordSchema) })
export type FixtureRecord = z.infer<typeof recordSchema>
