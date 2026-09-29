import { z } from "zod"

export const recordSchema = z.object({
  id: z.uuid(),
  organizationId: z.uuid(),
  creatorId: z.uuid(),
  title: z.string().trim().min(1).max(200),
  createdAt: z.iso.datetime(),
})
export const recordsPage = z.object({ items: z.array(recordSchema), next_cursor: z.string().nullable(), has_more: z.boolean() })
export const recordsView = z.object({ items: z.array(recordSchema) })
export type FixtureRecord = z.infer<typeof recordSchema>
