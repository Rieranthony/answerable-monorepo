import { z } from "zod"

export const recordSchema = z.object({
  id: z.uuid(),
  organizationId: z.uuid(),
  creatorId: z.uuid(),
  title: z.string().trim().min(1).max(200),
  createdAt: z.iso.datetime(),
})
export const createInput = z.object({
  title: z.string().trim().min(1).max(200),
}).strict()
export const deleteInput = z.object({ recordId: z.uuid() }).strict()
export const recordsOutput = z.object({ records: z.array(recordSchema) })
export const recordsViewOutput = recordsOutput.extend({ canWrite: z.boolean() })
export type FixtureRecord = z.infer<typeof recordSchema>
