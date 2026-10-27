import { buildView } from "@answerable/mcp/build"

/** The records view's HTML for `records.show`: `src/views/records.tsx` bundled with its CSS when this module is first imported. */
export const viewHtml = await buildView({ entry: Bun.fileURLToPath(new URL("./views/records.tsx", import.meta.url)), title: "Answerable test records" })
