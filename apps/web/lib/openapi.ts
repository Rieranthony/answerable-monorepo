import type { Document } from "fumadocs-openapi"
import { createOpenAPI } from "fumadocs-openapi/server"

export const openapi = createOpenAPI({
  input: {
    "answerable-id": async () =>
      (await import("../../id/openapi.json")).default as Document,
  },
})

export const adminOpenapi = createOpenAPI({
  input: {
    "answerable-id-admin": async () =>
      (await import("../../id/openapi.admin.json"))
        .default as unknown as Document,
  },
})
