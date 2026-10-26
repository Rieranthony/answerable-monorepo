# Answerable configuration

One typed definition per service of every environment variable it reads: its schema, whether it is a secret, its local value and what it means. The services read their environment through it, and `.env.example` and `inventory.json` are generated from it.

```ts
import { defineConfig } from "@answerable/config"
import { z } from "zod"

export const acmeConfig = defineConfig("Acme", {
  ACME_DATABASE_URL: { schema: z.url(), secret: true, local: "postgres://acme_runtime:answerable@localhost:47432/acme", doc: "Acme's Postgres URL as its runtime login", source: "cluster" },
  ACME_PORT: { schema: z.coerce.number().int().min(1).max(65535), fallback: "47600", doc: "The port Acme listens on", source: "image" },
})

const { NODE_ENV, ACME_DATABASE_URL, ACME_PORT } = acmeConfig.read(process.env)
```

## A field

| Key | What it is |
| --- | --- |
| `schema` | A zod schema of the raw string, with the coercions and transforms the service needs. It receives `undefined` when the variable is unset |
| `secret` | A credential: production refuses it when its value is `local` (`<NAME>: a development default`), so a development secret can be committed |
| `fallback` | The value in every profile when the variable is unset, as the service's own default |
| `local` | The value under `development` and `test` when the variable is unset. Never under production |
| `doc` | One line: what the variable is |
| `source` | Where a deployed environment's value comes from: `deploy` (the deploy step, from the GitHub environment), `cluster` (Terraform or the ops Jobs), `chart`, `image` or `operator`. Omitted for tooling and local-only variables |

`defineConfig(label, fields, { refine })` returns `{ label, read, fields }`. `refine(data, issue)` holds the rules that span variables, such as a pair set together; it runs once every variable parses, and `issue(name, message)` refuses one. `read(env)` throws a `ConfigError` whose message is `Invalid <label> configuration: <NAME>: <problem>; …`, naming each variable it refuses and never its value. `fields` describes every variable, `NODE_ENV` first, with `optional` (production starts with it unset).

## The profiles

`NODE_ENV` is `development`, `test` or `production`, and `development` when unset; any other value, an empty one included, is refused. Every other variable counts as unset when it is empty or blank. Development and test fill an unset variable with its `local` value, so a clone runs with no `.env`. Production fills none: every variable without a fallback is required. The images set `production`; staging and production run the same profile and differ only in what the chart and the deploy hand them.

## The inventories

`bun run env:inventory`, from the repository root, writes two files from every definition (`scripts/env-inventory.ts`):

- `.env.example`: the credentials another system issues, which have no local value: the platform applications' and the local machine clients'.
- `inventory.json`: every definition's fields, as `fields` gives them, under its label. The docs render its groups as tables.

`scripts/env-inventory.test.ts` fails when a committed copy differs. To add a variable, add it to its service's definition, then run `bun run env:inventory`.
