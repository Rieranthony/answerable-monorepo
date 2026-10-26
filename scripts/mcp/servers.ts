// The servers bun mcp dev starts: the Toolbox and the standalone server, each hot-reloading from its workspace's own dev script, and the wait for each
// to list the MCP on its /health.
import { join } from "node:path"
import type { Io, Running } from "./io"

/** The two servers of MCPs: its name in words, workspace, port and the two variables that name its machine client in ID. */
export const servers = {
  toolbox: { name: "the Toolbox", workspace: "mcps/toolbox", port: 47400, client: ["TOOLBOX_ID_CLIENT_ID", "TOOLBOX_ID_CLIENT_SECRET"] },
  standalone: { name: "the standalone server", workspace: "mcps/standalone", port: 47510, client: ["STANDALONE_ID_CLIENT_ID", "STANDALONE_ID_CLIENT_SECRET"] },
} as const
export type ServerName = keyof typeof servers

// Poll `url` until it lists `mcp` among its providers, the server stops, or the time is up; the server's own output, on the terminal, says why.
async function ready(io: Io, name: string, url: string, mcp: string, running: Running, { timeoutMs, pollMs }: { timeoutMs: number; pollMs: number }) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const body = await io.fetch(url, { signal: AbortSignal.timeout(2000) }).then(answer => answer.json() as Promise<{ providers?: string[] }>).catch(() => undefined)
    if (body?.providers?.includes(mcp)) return
    const code = await Promise.race([running.exited, Bun.sleep(pollMs).then(() => undefined)])
    if (code !== undefined) throw new Error(`${name} stopped with exit code ${code} before ${url} listed ${mcp}; its output above says why`)
    if (Date.now() > deadline) throw new Error(`${name} did not list ${mcp} at ${url} within ${timeoutMs / 1000} s; its output above says why`)
  }
}

/**
 * Start a server with `bun run dev` (its own script, whose command Bun need not echo) in its workspace, with `env` as its environment, and wait until its `/health` lists `mcp`. The running server is
 * added to `started` before the wait, so that the caller stops it even when the wait fails; the wait throws when the server stops first or is too slow.
 */
export async function startServer(io: Io, root: string, which: ServerName, mcp: string, env: Record<string, string>, started: Running[], wait = { timeoutMs: 60_000, pollMs: 100 }) {
  const { name, workspace, port } = servers[which]
  const running = io.start([process.execPath, "run", "--silent", "dev"], { cwd: join(root, workspace), env })
  started.push(running)
  await ready(io, name, `http://localhost:${port}/health`, mcp, running, wait)
}
