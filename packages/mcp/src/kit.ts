import type { UserPrincipal } from "@answerable/auth"
import type { CallToolResult } from "@modelcontextprotocol/server"
import { createMemoryIntentStore, type Intent, type IntentStore } from "./intents"
import { manifest as manifestOf, type Manifest } from "./manifest"
import { riskClass, type Target } from "./mutation"
import type { Provider } from "./provider"
import { createMcpServer } from "./server"
import { createTestMcp, testPrincipal } from "./test-mcp"

/** What the conformance kit needs from a provider's test besides the provider. */
export type ConformanceFixture = {
  /** The committed manifest, as a path or a URL such as `new URL("../manifest.json", import.meta.url)`. */
  manifest: string | URL
  /** One valid input for every tool and mutation, by name. A function may set up state first and returns the input. */
  examples: Record<string, Record<string, unknown> | ((principal: UserPrincipal) => Record<string, unknown> | Promise<Record<string, unknown>>)>
  /** Change a target outside the MCP, as another writer would, so that its version moves; it may return a promise. Needed only by a mutation that prepares targets. */
  moveTarget?(target: Target, principal: UserPrincipal): unknown
}

/** What the checks that read only the definitions need. */
export type Subject = { provider: Provider; manifest: Manifest; fixture: ConformanceFixture }
/** The provider served in-process, signed in as one caller, with its own intent store. */
export type Kit = Subject & {
  /** The caller the kit signs in as; `grantId` and `expiresAt` are placeholders. */
  principal: UserPrincipal
  /** Every intent the server recorded, in order. */
  stored: Intent[]
  /** Call a tool as the caller. */
  call(name: string, args: Record<string, unknown>): Promise<CallToolResult>
  close(): Promise<void>
}

/** Serve `provider` in-process for the checks. A high-risk mutation is human class, which cannot commit yet, so the kit runs it as controlled. */
export async function createKit(provider: Provider, fixture: ConformanceFixture): Promise<Kit> {
  const stored: Intent[] = []
  const memory = createMemoryIntentStore()
  const intents: IntentStore = { ...memory, async insert(intent) { stored.push(intent); await memory.insert(intent) } }
  const mcp = await createTestMcp(auth => createMcpServer({ provider, auth, intents, policyClass: ({ risk }) => riskClass[risk] === "human" ? "controlled" : riskClass[risk] }))
  const contract = manifestOf(provider)
  const scopes = [...new Set([...contract.tools, ...contract.prompts, ...contract.resources].flatMap(entry => entry.scopes))].sort()
  const principal = testPrincipal({ clientId: "conformance-kit", scopes })
  const client = await mcp.connect(principal)
  return {
    provider, manifest: contract, fixture, stored, principal,
    async call(name, args) { return await client.callTool({ name, arguments: args }) as CallToolResult },
    close: () => mcp.close(),
  }
}
