// Blocks the docs compute from the repository when a page builds, so they cannot drift from the code: what `mcp:new`
// writes, the SDK's error codes and policy classes, and the committed provider manifests. Each has a Markdown form.
import { asMarkdown } from "fumadocs-core/server"
import { ServerCodeBlock } from "fumadocs-ui/components/codeblock.rsc"
import type { ReactNode } from "react"

import { dataTable } from "@/components/docs/table"
import { errorRows } from "@/lib/docs/error-codes"
import { codeFence } from "@/lib/docs/markdown"

import {
  classExpiry,
  riskClass,
  type PolicyClass,
} from "../../../../packages/mcp/src/mutation"
import { scaffoldSources } from "../../../../scripts/mcp-templates"
import admin from "../../../../mcps/admin/manifest.json"
import e2e from "../../../../mcps/e2e/manifest.json"
import example from "../../../../mcps/example/manifest.json"
import toolbox from "../../../../mcps/toolbox/manifest.json"

const manifests = { admin, e2e, example, toolbox }
type Workspace = keyof typeof manifests

// Plain functions, not components: `asMarkdown()` opts in the component that calls it, so each exported block must call
// it in its own render.
function codeBlock({
  code,
  lang,
  title,
}: {
  code: string
  lang: string
  title: string
}): ReactNode {
  if (asMarkdown()) return `${codeFence(code, lang, title)}\n\n`

  return <ServerCodeBlock code={code} lang={lang} codeblock={{ title }} />
}

const today = new Date().toISOString().slice(0, 10)
const languages: Record<string, string> = { ts: "ts", example: "dotenv" }
// The example name every page scaffolds with: `mcps/acme/<file>`.
const SCAFFOLD_NAME = "acme"

/** A file exactly as `bun run mcp:new <name>` writes it, dated the day the docs were built. */
export function ScaffoldFile({ file }: { file: string }) {
  const source = scaffoldSources(SCAFFOLD_NAME, today)[file]

  if (source === undefined) {
    throw new Error(`mcp:new writes no ${file} from a template`)
  }

  return codeBlock({
    code: source,
    lang: languages[file.split(".").pop()!] ?? "text",
    title: `mcps/${SCAFFOLD_NAME}/${file}`,
  })
}

/** One tool of a committed manifest: the contract the SDK derives from its definition. */
export function ManifestEntry({
  workspace,
  identity,
}: {
  workspace: Workspace
  identity: string
}) {
  const entry = manifests[workspace].tools.find(
    (tool) => tool.identity === identity,
  )

  if (!entry)
    throw new Error(`mcps/${workspace}/manifest.json has no ${identity}`)

  return codeBlock({
    code: JSON.stringify(entry, null, 2),
    lang: "json",
    title: `mcps/${workspace}/manifest.json`,
  })
}

/** The grant strings that cover a provider's capabilities: the provider, each domain and each capability. */
export function GrantStrings({ workspace }: { workspace: Workspace }) {
  const { id, tools } = manifests[workspace]
  const capabilities = tools
    .filter((tool) => tool.kind !== "commit")
    .map((tool) => tool.identity)
  const domains = [
    ...new Set(capabilities.map((identity) => identity.split(".")[0]!)),
  ]
  const rows = [
    [`\`${id}\``, `Every capability of \`${id}\``],
    ...domains.map((domain) => [
      `\`${domain}\``,
      capabilities
        .filter((identity) => identity.startsWith(`${domain}.`))
        .map((identity) => `\`${identity}\``)
        .join(", "),
    ]),
    ...capabilities.map((identity) => [`\`${identity}\``, "That capability"]),
  ]

  return dataTable({ headers: ["Grant string", "Covers"], rows })
}

/** Every standard error code of @answerable/mcp with its default retry policy, meaning and what to do. */
export function ErrorCodes() {
  return dataTable({
    headers: ["Code", "Meaning", "Retry", "What to do"],
    rows: errorRows.map((row) => [
      `\`${row.code}\``,
      row.meaning,
      `\`${row.retry}\``,
      row.action,
    ]),
  })
}

const commitWith: Record<PolicyClass, string> = {
  agent: "`<id>_commit`",
  controlled: "`<id>_commit_confirmed`, after the person sees the summary",
  human: "A person's approval. Not yet",
}

const duration = (ms: number) =>
  ms % 3_600_000 === 0 ? `${ms / 3_600_000} hours` : `${ms / 60_000} minutes`

/** How each risk maps to a policy class, which commit tool applies it and how long its intents last. */
export function PolicyClasses() {
  return dataTable({
    headers: ["`risk`", "Class", "Commit with", "Expiry after prepare"],
    rows: Object.entries(riskClass).map(([risk, policyClass]) => [
      `\`${risk}\``,
      `\`${policyClass}\``,
      commitWith[policyClass],
      duration(classExpiry[policyClass]),
    ]),
  })
}
