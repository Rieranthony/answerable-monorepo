import { z } from "zod"

export const recordSchema = z.object({
  id: z.uuid(),
  organizationId: z.uuid(),
  creatorId: z.uuid(),
  title: z.string().trim().min(1).max(200),
  createdAt: z.iso.datetime(),
  /** Starts at 1 and grows with every change; records.delete binds it as its target's version. */
  version: z.number().int().min(1),
})
export const recordsPage = z.object({ items: z.array(recordSchema), next_cursor: z.string().nullable(), has_more: z.boolean() })
export const recordsView = z.object({ items: z.array(recordSchema), canWrite: z.boolean() })
export type FixtureRecord = z.infer<typeof recordSchema>
