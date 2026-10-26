// Where the stack bun mcp works against listens: Answerable ID, the Toolbox and the standalone server, and where ID sends Claude Code back.
/** The addresses of a stack: ID, the Toolbox, the standalone server and the OAuth callback of the host. */
export type Stack = {
  /** Answerable ID's origin. */
  id: string
  /** ID's admin resource, the audience of a machine client's admin tokens. */
  adminResource: string
  /** The Toolbox's origin, its MCP resource and its admin resource. */
  toolbox: string
  toolboxResource: string
  toolboxAdminResource: string
  /** The standalone server's origin: each standalone MCP is the resource `<origin>/<name>/mcp`. */
  standalone: string
  /** The port Claude Code listens on for ID's redirect, `--callback-port`, and the redirect URI registered for its clients. */
  callbackPort: number
  callback: string
}

/** The stack of a stack's origins: ID's admin resource and the Toolbox's two resources are theirs with a path. */
export const stackAt = ({ id, toolbox, standalone, callbackPort, callbackHost = "localhost" }: { id: string; toolbox: string; standalone: string; callbackPort: number; callbackHost?: string }): Stack => ({
  id, adminResource: `${id}/api/admin`, toolbox, toolboxResource: `${toolbox}/mcp`, toolboxAdminResource: `${toolbox}/admin`, standalone, callbackPort, callback: `http://${callbackHost}:${callbackPort}/callback`,
})

/** The local stack, at the ports AGENTS.md names. */
export const local = stackAt({ id: "http://localhost:47300", toolbox: "http://localhost:47400", standalone: "http://localhost:47510", callbackPort: 47700 })
