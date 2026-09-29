import { z } from "zod"

/** Bundle a browser entry file with Bun's bundler, in a separate process, and return each output file's path and text. */
export async function bundleBrowser(entry: string) {
  const worker = Bun.spawn([process.execPath, new URL("./build-worker.ts", import.meta.url).pathname, entry], { stdout: "pipe", stderr: "pipe" })
  const [code, stdout, stderr] = await Promise.all([worker.exited, new Response(worker.stdout).text(), new Response(worker.stderr).text()])
  if (code !== 0) throw new Error(`View build failed: ${stderr}`)
  return z.array(z.object({ path: z.string(), text: z.string() })).parse(JSON.parse(stdout))
}

/**
 * Bundle a browser entry and its CSS into one self-contained HTML document for `defineView`.
 * It refuses output that is not one script and optional CSS.
 *
 * @example
 * ```ts
 * import { buildView } from "@answerable/mcp/build"
 *
 * const html = await buildView({ entry: "src/views/records.tsx", title: "Records" })
 * ```
 */
export async function buildView(options: {
  /** Absolute or working-directory-relative path of the browser entry file. */
  entry: string
  /** The document's `<title>`. */
  title: string
}) {
  const outputs = await bundleBrowser(options.entry)
  const scripts = outputs.filter(file => file.path.endsWith(".js")).map(file => file.text)
  const styles = outputs.filter(file => file.path.endsWith(".css")).map(file => file.text)
  if (scripts.length !== 1 || outputs.some(file => !/\.(js|css)$/.test(file.path))) {
    const files = outputs.map(file => file.path.split("/").at(-1)).join(", ")
    throw new Error(`Views must bundle to one script and optional CSS; ${options.entry} bundled to ${files}; embed the other files in the script or the CSS`)
  }
  const title = options.title.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style>${styles.join("\n").replace(/<\/style/gi, "<\\/style")}</style></head><body><div id="root"></div><script type="module">${scripts[0].replace(/<\/script/gi, "<\\/script")}</script></body></html>`
}
