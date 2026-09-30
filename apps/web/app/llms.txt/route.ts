import { llms } from "fumadocs-core/source"

import { source } from "@/lib/source"

export const revalidate = false

// The llms.txt shape: a title, a one-paragraph summary, where to start, then every page.
const intro = `# Answerable docs

> Answerable ID signs people in with their organisation's directory and issues tokens that say who they are and what their organisation lets them use. The MCP kit (\`@answerable/mcp\`) builds MCP servers that trust those tokens. The Toolbox is one MCP endpoint that serves each person the tools their organisation granted them. Every page below is also Markdown: append \`.md\` to its URL, or send \`Accept: text/markdown\`. [/llms-full.txt](/llms-full.txt) holds every page in one file.

## Start here

- [Build your first MCP](/docs/mcp/quickstart): scaffold a server, add a read tool and a mutation, test them, connect Claude Code
- [How Answerable ID works](/docs/id): organisations, members, clients, resources, scopes and tokens
- [Add tools to the Toolbox](/docs/toolbox/add-tools): mount a provider, enable it for an organisation, grant it to people
- [Build with an AI agent](/docs/agents): prompts to paste into a coding agent working in this repository
`

export async function GET() {
  const index = (await llms(source).index()).replace(
    /^# Docs\n/,
    "## All pages\n",
  )

  return new Response(`${intro}\n${index}`)
}
