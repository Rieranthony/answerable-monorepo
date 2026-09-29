/** The part of a JSON Schema the checks read. */
export type Schema = { type?: string | string[]; format?: string; properties?: Record<string, Schema>; items?: Schema; anyOf?: Schema[]; oneOf?: Schema[] }
// A schema's alternatives without null: what `.nullable()` and `.optional()` leave.
const variants = (schema: Schema): Schema[] => (schema.anyOf ?? schema.oneOf ?? [schema]).flatMap(option => option === schema ? [schema] : variants(option)).filter(option => option.type !== "null")
const typeOf = (schema: Schema) => [schema.type].flat().filter(type => type !== "null").join()
const accepts = (schema: Schema, test: (option: Schema) => boolean) => variants(schema).every(test)
const timestamp = (option: Schema) => typeOf(option) === "string" && option.format === "date-time"
const quantity = (option: Schema) => typeOf(option) === "object" && "value" in (option.properties ?? {}) && "unit" in (option.properties ?? {})

/** The R13 problems of an output schema: a `*_at` property that is not a `date-time` string, and an `amount`, `area` or `duration` that is not `{ value, unit }`. */
export function lintOutput(schema: Schema, path = "", problems: string[] = []) {
  for (const option of variants(schema)) {
    for (const [name, property] of Object.entries(option.properties ?? {})) {
      const at = path ? `${path}.${name}` : name
      if (name.endsWith("_at") && !accepts(property, timestamp)) problems.push(`output property "${at}" is named like a timestamp, so it must be a string with format date-time, for example z.iso.datetime()`)
      if (["amount", "area", "duration"].includes(name) && !accepts(property, quantity)) problems.push(`output property "${at}" is named like a quantity, so it must be an object with value and unit, for example { value: 12, unit: "m2" }`)
      lintOutput(property, at, problems)
    }
    if (option.items) lintOutput(option.items, `${path}[]`, problems)
  }
  return problems
}
