import type { UserPrincipal } from "@answerable/auth"
import type { CallToolResult } from "@modelcontextprotocol/server"
import { createMemoryIntentStore, type Intent, type IntentStore } from "./intents"
import { manifest as manifestOf, type Manifest } from "./manifest"
import { riskClass, type Target } from "./mutation"
import type { Provider } from "./provider"
import { createTestMcp } from "./test-mcp"

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
/** The provider served in-process, signed in as one caller, with its own intent store and clock. */
export type Kit = Subject & {
  /** The caller the kit signs in as; `grantId` and `expiresAt` are placeholders. */
  principal: UserPrincipal
  /** Every intent the server recorded, in order. */
  stored: Intent[]
  /** Call a tool as the caller (`owner`) or as another person (`other`). */
  call(name: string, args: Record<string, unknown>, as?: "owner" | "other"): Promise<CallToolResult>
  /** Move the intent store's clock forward to an epoch time in milliseconds. */
  advanceTo(epochMs: number): void
  close(): Promise<void>
}

/** Serve `provider` in-process for the checks. A high-risk mutation is human class, which cannot commit yet, so the kit runs it as controlled. */
export async function createKit(provider: Provider, fixture: ConformanceFixture): Promise<Kit> {
  const clock = { now: Date.now() }
  const stored: Intent[] = []
  const memory = createMemoryIntentStore({ now: () => clock.now })
  const intents: IntentStore = { ...memory, async insert(intent) { stored.push(intent); await memory.insert(intent) } }
  const mcp = await createTestMcp(provider, { intents, policyClass: ({ risk }) => riskClass[risk] === "human" ? "controlled" : riskClass[risk] })
  const contract = manifestOf(provider)
  const scopes = [...new Set([...contract.tools, ...contract.prompts, ...contract.resources].flatMap(entry => entry.scopes))].sort()
  const caller = { userId: crypto.randomUUID(), organizationId: crypto.randomUUID(), membershipId: crypto.randomUUID(), clientId: "conformance-kit" }
  const clients = { owner: await mcp.connect({ ...caller, scopes }), other: await mcp.connect({ scopes }) }
  return {
    provider, manifest: contract, fixture, stored,
    principal: { ...caller, grantId: crypto.randomUUID(), scopes, expiresAt: Math.floor(Date.now() / 1000) + 300 },
    async call(name, args, as = "owner") { return await clients[as].callTool({ name, arguments: args }) as CallToolResult },
    advanceTo(epochMs) { clock.now = Math.max(clock.now, epochMs) },
    close: () => mcp.close(),
  }
}
