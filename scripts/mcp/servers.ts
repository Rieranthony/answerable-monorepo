// The server bun mcp dev starts: the Toolbox, which serves every MCP in its hub or alone, hot-reloading from its workspace's own dev script, and the
// wait for it to list the MCP on its /health.
import { join } from "node:path"
import type { Io, Running } from "./io"

/** The Toolbox: its name in words, workspace, port and the two variables that name its machine client in ID. */
export const toolbox = { name: "the Toolbox", workspace: "mcps/toolbox", port: 47400, client: ["TOOLBOX_ID_CLIENT_ID", "TOOLBOX_ID_CLIENT_SECRET"] } as const

// Poll `url` until it lists `mcp` among its providers, the server stops, or the time is up; the server's own output, on the terminal, says why.
async function ready(io: Io, url: string, mcp: string, running: Running, { timeoutMs, pollMs }: { timeoutMs: number; pollMs: number }) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const body = await io.fetch(url, { signal: AbortSignal.timeout(2000) }).then(answer => answer.json() as Promise<{ providers?: string[] }>).catch(() => undefined)
    if (body?.providers?.includes(mcp)) return
    const code = await Promise.race([running.exited, Bun.sleep(pollMs).then(() => undefined)])
    if (code !== undefined) throw new Error(`${toolbox.name} stopped with exit code ${code} before ${url} listed ${mcp}; its output above says why`)
    if (Date.now() > deadline) throw new Error(`${toolbox.name} did not list ${mcp} at ${url} within ${timeoutMs / 1000} s; its output above says why`)
  }
}

/**
 * Start the Toolbox with `bun run dev` (its own script, whose command Bun need not echo) in its workspace, with `env` as its environment, and wait until its `/health` lists `mcp`. The running server is
 * added to `started` before the wait, so that the caller stops it even when the wait fails; the wait throws when the server stops first or is too slow.
 */
export async function startToolbox(io: Io, root: string, mcp: string, env: Record<string, string>, started: Running[], wait = { timeoutMs: 60_000, pollMs: 100 }) {
  const running = io.start([process.execPath, "run", "--silent", "dev"], { cwd: join(root, toolbox.workspace), env })
  started.push(running)
  await ready(io, `http://localhost:${toolbox.port}/health`, mcp, running, wait)
}
