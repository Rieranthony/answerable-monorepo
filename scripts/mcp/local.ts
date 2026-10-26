// Where the stack bun mcp works against listens: Answerable ID and the Toolbox, and where ID sends Claude Code back.
/** The addresses of a stack: ID, the Toolbox, which serves each standalone MCP at `<origin>/<name>/mcp` beside its hub, and the OAuth callback of the host. */
export type Stack = {
  /** Answerable ID's origin. */
  id: string
  /** ID's admin resource, the audience of a machine client's admin tokens. */
  adminResource: string
  /** The Toolbox's origin, where each standalone MCP is the resource `<origin>/<name>/mcp`, its hub's resource and its admin resource. */
  toolbox: string
  toolboxResource: string
  toolboxAdminResource: string
  /** The port Claude Code listens on for ID's redirect, `--callback-port`, and the redirect URI registered for its clients. */
  callbackPort: number
  callback: string
}

/** The stack of a stack's origins: ID's admin resource and the Toolbox's two resources are theirs with a path. */
export const stackAt = ({ id, toolbox, callbackPort, callbackHost = "localhost" }: { id: string; toolbox: string; callbackPort: number; callbackHost?: string }): Stack => ({
  id, adminResource: `${id}/api/admin`, toolbox, toolboxResource: `${toolbox}/mcp`, toolboxAdminResource: `${toolbox}/admin`, callbackPort, callback: `http://${callbackHost}:${callbackPort}/callback`,
})

/** The local stack, at the ports AGENTS.md names. */
export const local = stackAt({ id: "http://localhost:47300", toolbox: "http://localhost:47400", callbackPort: 47700 })
