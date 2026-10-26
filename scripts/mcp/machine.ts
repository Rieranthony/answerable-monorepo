// The real machine around bun mcp, which a test replaces: a long-running process, a TCP probe and Ctrl-C.
import { spawn } from "node:child_process"
import { connect } from "node:net"
import os from "node:os"
import type { Start } from "./io"

/**
 * A `Start` for `bun mcp dev`: it runs the command in `cwd` with exactly `env` as its environment, its output going to the terminal, as the leader of a
 * process group of its own, which is `bun run dev`'s process and the server it runs. `stop()` asks the group to end with SIGTERM, and kills what is
 * left of it after `graceMs`: a server run with `bun --hot` closes its port on SIGTERM and then stays alive to watch for changes, so it never ends alone.
 */
export const processStarter = (graceMs: number): Start => (command, { cwd, env }) => {
  const [file, ...args] = command
  const child = spawn(file!, args, { cwd, env, stdio: ["ignore", "inherit", "inherit"], detached: true })
  const exited = new Promise<number>(resolve => child.once("exit", (code, signal) => resolve(code ?? (signal ? 128 + (os.constants.signals[signal] ?? 0) : 1))))
  const signalGroup = (signal: NodeJS.Signals) => { try { process.kill(-child.pid!, signal) } catch { /* the group has ended */ } }
  const alive = () => { try { return process.kill(-child.pid!, 0) } catch { return false } }
  return {
    exited,
    async stop() {
      signalGroup("SIGTERM")
      for (const deadline = Date.now() + graceMs; alive() && Date.now() < deadline;) await Bun.sleep(20)
      signalGroup("SIGKILL")
      await exited
    },
  }
}

/** Whether something accepts a connection at `host:port`. */
export const listening = (host: string, port: number) =>
  new Promise<boolean>(resolve => {
    const socket = connect({ host, port })
    socket.once("connect", () => (socket.destroy(), resolve(true)))
    socket.once("error", () => resolve(false))
  })

/**
 * A signal that aborts on the first Ctrl-C or SIGTERM. Those signals no longer end the process by themselves: a second Ctrl-C while the servers are being
 * stopped, which takes a second at most, would leave them behind, since each is in a process group of its own.
 */
export function interrupt() {
  const controller = new AbortController()
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => controller.abort())
  return controller.signal
}
