// The records view's HTML, read once by whoever serves the provider: this server and the Toolbox.
const file = Bun.file(new URL("../dist/records.html", import.meta.url))
if (!await file.exists()) throw new Error("Missing the e2e records view. Run bun run --filter @answerable/mcp-e2e build first.")

/** The records view's HTML for `createE2eProvider({ viewHtml })`: `dist/records.html`, which `bun run --filter @answerable/mcp-e2e build` writes. Importing it throws when the view is not built. */
export const viewHtml = await file.text()
