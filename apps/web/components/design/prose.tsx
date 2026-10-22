import type { ComponentProps } from "react"
import { evaluate } from "@mdx-js/mdx"
import * as runtime from "react/jsx-runtime"
import remarkGfm from "remark-gfm"
import { cn } from "@answerable/ui/lib/utils"

// A DESIGN.md section's prose, rendered on the server at build: plain Markdown with GFM tables, set in the
// design's own levels. No component is evaluated from the file; `format: "md"` reads no JSX or expressions.
const components = {
  h2: (props: ComponentProps<"h2">) => (
    <h3 className="type-heading-h3 mt-2" {...props} />
  ),
  h3: (props: ComponentProps<"h3">) => (
    <h3 className="type-heading-h3 mt-2" {...props} />
  ),
  h4: (props: ComponentProps<"h4">) => (
    <h4 className="type-heading-h4" {...props} />
  ),
  p: (props: ComponentProps<"p">) => <p {...props} />,
  strong: (props: ComponentProps<"strong">) => (
    <strong className="font-label" {...props} />
  ),
  // One square marker per item, the bullet the design draws; numbered lists keep their numerals.
  ul: (props: ComponentProps<"ul">) => (
    <ul
      className="[&>li]:before:bg-foreground flex list-none flex-col gap-1 [&_ul]:mt-1 [&>li]:relative [&>li]:pl-4 [&>li]:before:absolute [&>li]:before:top-[calc(0.5lh-3px)] [&>li]:before:left-0 [&>li]:before:size-1.5 [&>li]:before:content-['']"
      {...props}
    />
  ),
  ol: (props: ComponentProps<"ol">) => (
    <ol className="flex list-decimal flex-col gap-1 pl-5" {...props} />
  ),
  code: (props: ComponentProps<"code">) => (
    <code className="bg-muted px-1 font-mono text-[0.9em]" {...props} />
  ),
  blockquote: (props: ComponentProps<"blockquote">) => (
    <blockquote className="bg-muted p-4" {...props} />
  ),
  hr: () => null,
  table: (props: ComponentProps<"table">) => (
    <div className="w-full overflow-x-auto">
      <table className="type-ui-text w-full" {...props} />
    </div>
  ),
  tr: (props: ComponentProps<"tr">) => (
    <tr className="border-border border-b last:border-0" {...props} />
  ),
  th: (props: ComponentProps<"th">) => (
    <th
      className="type-table-head text-muted-foreground px-3 py-2 text-left align-bottom"
      {...props}
    />
  ),
  td: (props: ComponentProps<"td">) => (
    <td className="px-3 py-2 align-top" {...props} />
  ),
  a: (props: ComponentProps<"a">) => (
    <a className="underline decoration-2 underline-offset-4" {...props} />
  ),
}

/** The section's heading line comes off: the showcase sets its own. */
export function sectionBody(markdown: string) {
  return markdown.replace(/^\s*#{1,6} [^\n]*\n/, "").trim()
}

export async function Prose({
  markdown,
  className,
}: {
  markdown: string
  className?: string
}) {
  const { default: Content } = await evaluate(markdown, {
    ...runtime,
    format: "md",
    remarkPlugins: [remarkGfm],
  })

  return (
    <div
      className={cn(
        // Text keeps the reading width; tables, wrapped in a div, take the section's.
        "type-body-md flex flex-col gap-4 [&>:not(div)]:max-w-(--prose-max)",
        className,
      )}
    >
      <Content components={components} />
    </div>
  )
}
