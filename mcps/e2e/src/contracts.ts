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
export const pageInput = z.object({
  limit: z.number().int().min(1).max(100).default(20).describe("Records per page, 1 to 100"),
  cursor: z.string().optional().describe("next_cursor from the previous page; omit it for the first page"),
})
export const recordsPage = z.object({ items: z.array(recordSchema), next_cursor: z.string().nullable(), has_more: z.boolean() })
export const recordsView = recordsPage.extend({ canWrite: z.boolean() })
export type FixtureRecord = z.infer<typeof recordSchema>
