// References: `{path.to.value}` anywhere in the YAML tree, resolved through the whole tree.
import type { Finding } from "./types"

/** A YAML mapping, as `yaml` parses it. */
export type Tree = Record<string, unknown>

/** Whether a value is a mapping. */
export function isTree(value: unknown): value is Tree {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

const WHOLE = /^\{([A-Za-z0-9._-]+)\}$/
const EMBEDDED = /\{([A-Za-z0-9._-]+)\}/g

/** The path a value references when the whole value is one reference, such as `colors.primary` for `{colors.primary}`. */
export function referenceOf(value: unknown): string | undefined {
  return typeof value === "string" ? WHOLE.exec(value.trim())?.[1] : undefined
}

/** The keys a dotted path walks in a tree; a key may itself hold dots (`spacing.0.5`). */
export function locate(tree: unknown, path: string): string[] | undefined {
  const walk = (node: unknown, rest: string[]): string[] | undefined => {
    if (rest.length === 0) return []
    if (!isTree(node)) return undefined
    for (let take = rest.length; take > 0; take--) {
      const key = rest.slice(0, take).join(".")
      if (Object.hasOwn(node, key)) {
        const tail = walk(node[key], rest.slice(take))
        if (tail) return [key, ...tail]
      }
    }
    return undefined
  }
  return walk(tree, path.split("."))
}

/** The value at a path of a tree, or undefined. */
export function valueOf(tree: unknown, path: string): unknown {
  const keys = locate(tree, path)
  return keys?.reduce<unknown>((node, key) => (node as Tree)[key], tree)
}

/** A tree with its references resolved, the references it holds, and what went wrong. */
export interface Resolution {
  resolved: Tree
  /** Path → the path its whole value references. */
  refs: Record<string, string>
  findings: Finding[]
}

const join = (path: string, key: string) => (path ? `${path}.${key}` : key)

function primitive(value: unknown): value is string | number | boolean {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
}

/**
 * Resolves every reference of a tree. A value that is one whole reference takes the referenced value,
 * a group included (the caller decides where groups are allowed); references inside a longer string take
 * the referenced primitive. Missing and circular whole references are errors, missing references inside a
 * longer string are warnings; either keeps the text as written.
 */
export function resolveTree(raw: Tree): Resolution {
  const refs: Record<string, string> = {}
  const findings: Finding[] = []
  const reported = new Set<string>()

  const report = (finding: Finding) => {
    const key = `${finding.path}|${finding.message}`
    if (reported.has(key)) return
    reported.add(key)
    findings.push(finding)
  }

  const target = (
    ref: string,
    stack: readonly string[],
  ): { value: unknown } | "missing" | "circular" => {
    const keys = locate(raw, ref)
    if (!keys) return "missing"
    const path = keys.join(".")
    if (stack.includes(path)) return "circular"
    const value = keys.reduce<unknown>((node, key) => (node as Tree)[key], raw)
    return { value: node(value, path, [...stack, path]) }
  }

  const node = (
    value: unknown,
    path: string,
    stack: readonly string[],
  ): unknown => {
    if (typeof value === "string") {
      const ref = referenceOf(value)
      if (ref !== undefined) {
        refs[path] = ref
        const found = target(ref, stack)
        if (typeof found === "object") return found.value
        report({
          severity: "error",
          path,
          rule: "profile-reference",
          message:
            found === "missing"
              ? `Reference {${ref}} does not resolve to any value in the file.`
              : `Reference {${ref}} is circular.`,
        })
        return value
      }
      return value.replace(EMBEDDED, (text, inner: string) => {
        const found = target(inner, stack)
        if (typeof found === "object" && primitive(found.value))
          return String(found.value)
        if (found === "missing") {
          report({
            severity: "warning",
            path,
            rule: "profile-reference",
            message: `Reference {${inner}} in this text does not resolve to any value in the file.`,
          })
        }
        return text
      })
    }
    if (Array.isArray(value)) {
      return value.map((item, at) => node(item, join(path, String(at)), stack))
    }
    if (isTree(value)) {
      return Object.fromEntries(
        Object.entries(value).map(([key, child]) => [
          key,
          node(child, join(path, key), stack),
        ]),
      )
    }
    return value
  }

  return { resolved: node(raw, "", []) as Tree, refs, findings }
}
