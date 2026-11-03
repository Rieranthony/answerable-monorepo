// Writes src/generated/templates.generated.ts from the React templates: bun run --filter @answerable/emails generate.
import { generateModule } from "../src/react"

const target = new URL(
  "../src/generated/templates.generated.ts",
  import.meta.url,
)
await Bun.write(target, await generateModule())
console.log(
  `Wrote packages/emails/src/generated/templates.generated.ts (${Bun.file(target).size} bytes)`,
)
