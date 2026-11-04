/** The stack's company directories' ports on the host (apps/id/scripts/stack-directories.ts): the platform organisation's, then a client organisation's. */
export const directoryPort = 47_710
export const directoryPorts = [directoryPort, directoryPort + 1]

/** The fake Postmark's port on the host (packages/acceptance startFakePostmark), beside the directories'. */
export const postmarkPort = directoryPort + 2

/**
 * What ID's pods may reach besides HTTPS outside the private ranges (`id.extraEgress`): this host, on the directories' ports and the fake
 * Postmark's, and nothing else. The Toolbox, the admin MCP and the Jobs get none of it.
 */
export const idExtraEgress = (podHost: string) => [{ to: [{ ipBlock: { cidr: `${podHost}/32` } }], ports: [...directoryPorts, postmarkPort].map(port => ({ port, protocol: "TCP" })) }]
