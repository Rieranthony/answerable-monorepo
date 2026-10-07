import defaultMdxComponents from "fumadocs-ui/mdx"
import type { MDXComponents } from "mdx/types"

import {
  ErrorCodes,
  GrantStrings,
  ManifestEntry,
  PolicyClasses,
  ScaffoldFile,
} from "@/components/docs/generated"
import {
  AutoTypeTable,
  Callout,
  Card,
  Cards,
  Step,
  Steps,
  Tab,
  Tabs,
} from "@/components/docs/mdx-components"

export function getMDXComponents(components?: MDXComponents): MDXComponents {
  return {
    ...defaultMdxComponents,
    AutoTypeTable,
    Callout,
    Card,
    Cards,
    Step,
    Steps,
    Tab,
    Tabs,
    ErrorCodes,
    GrantStrings,
    ManifestEntry,
    PolicyClasses,
    ScaffoldFile,
    ...components,
  }
}

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>
}
