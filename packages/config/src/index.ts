import { z } from "zod"

type Profile = "development" | "test" | "production"
type Source = "deploy" | "cluster" | "chart" | "image" | "operator"
type Defaults = { development?: string; test?: string }
type Env = Record<string, string | undefined>

/** One variable a service reads. */
export type Field = {
  /** A zod schema of the raw string, with the coercions and transforms the service needs; it receives `undefined` when the variable is unset. */
  schema: z.ZodType
  /** A credential. Production refuses it when its value is one of `defaults`, so a development default can be committed. */
  secret?: boolean
  /** The value in every profile when the variable is unset, as the loader's own default. */
  fallback?: string
  /** The value under `development` or `test` when the variable is unset or empty; never under `production`. */
  defaults?: Defaults
  /** One line: what the variable is. It is the comment above the variable in `default.env`. */
  doc: string
  /** Where a deployed environment's value comes from: the deploy step, the cluster (Terraform or the ops Jobs), the chart, the image or an operator. Omitted for tooling and local-only variables. */
  source?: Source
}

/** A field's description, for the inventories: what `defineConfig` returns as `fields`. */
export type FieldMeta = {
  name: string
  secret: boolean
  fallback?: string
  defaults?: Defaults
  doc: string
  source?: Source
  /** Whether production starts with the variable unset: the schema accepts `undefined`, or a fallback stands in. */
  optional: boolean
}

type Data<Fields extends Record<string, Field>> = { NODE_ENV: Profile } & { [Name in keyof Fields]: z.output<Fields[Name]["schema"]> }

/** A service's configuration: its label, `read`, and every variable it reads, `NODE_ENV` first. */
export type Config<Fields extends Record<string, Field>> = {
  label: string
  /** Parse `env` into typed data, `NODE_ENV` included; throws a `ConfigError` naming every variable it refuses. */
  read(env: Env): Data<Fields>
  fields: FieldMeta[]
}

/** The configuration `read` refused: `issues` names each variable and its problem, never its value. */
export class ConfigError extends Error {
  constructor(label: string, readonly issues: { name: string; message: string }[]) {
    super(`Invalid ${label} configuration: ${issues.map(({ name, message }) => `${name}: ${message}`).join("; ")}`)
    this.name = "ConfigError"
  }
}

/** The same default under `development` and `test`. */
export const locally = (value: string): Defaults => ({ development: value, test: value })

const profiles = z.enum(["development", "test", "production"]).default("development")
const nodeEnv: FieldMeta = {
  name: "NODE_ENV",
  secret: false,
  fallback: "development",
  doc: "development, test or production (unset, development): the first two fill unset variables with local defaults, production none; the images set production",
  source: "image",
  optional: true,
}

/**
 * Define the variables a service reads. `read(env)` takes `NODE_ENV` (default `development`), fills each unset variable with its profile's
 * default, then its fallback, parses it with its schema, and runs `refine` for the rules that span variables once every variable parses.
 *
 * @example
 * ```ts
 * const config = defineConfig("Acme", {
 *   ACME_DATABASE_URL: { schema: z.url(), secret: true, defaults: locally("postgres://localhost:47432/acme"), doc: "The database", source: "cluster" },
 *   ACME_PORT: { schema: z.coerce.number().int(), fallback: "47600", doc: "The port to listen on", source: "image" },
 * })
 * const { ACME_DATABASE_URL, ACME_PORT } = config.read(process.env)
 * ```
 */
export function defineConfig<Fields extends Record<string, Field>>(
  label: string,
  fields: Fields,
  options: { refine?: (data: Data<Fields>, issue: (name: keyof Fields & string, message: string) => void) => void } = {},
): Config<Fields> {
  return {
    label,
    fields: [
      nodeEnv,
      ...Object.entries(fields).map(([name, { schema, secret = false, fallback, defaults, doc, source }]) => ({
        name, secret, fallback, defaults, doc, source, optional: fallback !== undefined || schema.safeParse(undefined).success,
      })),
    ],
    read(env) {
      const issues: { name: string; message: string }[] = []
      const profile = profiles.safeParse(env.NODE_ENV)
      if (!profile.success) for (const { message } of profile.error.issues) issues.push({ name: "NODE_ENV", message })
      const data: Record<string, unknown> = { NODE_ENV: profile.data }
      for (const [name, field] of Object.entries(fields)) {
        const raw = env[name]
        const local = profile.data === "development" || profile.data === "test" ? field.defaults?.[profile.data] : undefined
        const value = !raw && local !== undefined ? local : (raw ?? field.fallback)
        if (profile.data === "production" && field.secret && value !== undefined && Object.values(field.defaults ?? {}).includes(value)) {
          issues.push({ name, message: "a development default" })
          continue
        }
        const result = field.schema.safeParse(value)
        if (result.success) data[name] = result.data
        else for (const { message } of result.error.issues) issues.push({ name, message })
      }
      if (!issues.length) options.refine?.(data as Data<Fields>, (name, message) => issues.push({ name, message }))
      if (issues.length) throw new ConfigError(label, issues)
      return data as Data<Fields>
    },
  }
}
