import type { ReactNode } from "react"
import type { Design } from "@answerable/design"

import { ContrastTable, ColourSwatches, RotationStats } from "./colour"
import { DosAndDonts } from "./dos-and-donts"
import { FindingLists } from "./findings"
import { ShowcaseHeader } from "./header"
import { InterfaceComponents } from "./interface"
import { accentAt, sectionId, type Accent } from "./lib"
import { Overview } from "./overview"
import { Prose, sectionBody } from "./prose"
import { ShowcaseGroup, ShowcaseSection } from "./section"
import { StatementComponents } from "./statement"
import { AppShell, Elevation, LinesAndFocus, Shape } from "./surfaces"
import { ProseMeasure, TypeSpecimen, TypeWeights } from "./typography"

type Module = {
  match: RegExp
  /** The layout that shows the section working. */
  render: (context: {
    design: Design
    accent: Accent
    body: string
  }) => ReactNode
  /** Set when the layout is the prose itself, so the prose is not repeated behind a toggle. */
  ownsProse?: true
}

// Each layout claims the first section whose heading it matches, so the page follows the file's order.
const MODULES: Module[] = [
  { match: /^overview/i, render: ({ accent }) => <Overview accent={accent} /> },
  {
    match: /^colou?rs?\b/i,
    render: ({ accent }) => (
      <div className="flex flex-col gap-12">
        <ColourSwatches />
        <ShowcaseGroup
          title="Contrast"
          caption="Every text-on-fill pair of the roles, against WCAG 2: AA needs 4.5:1 for normal text, 3:1 for large."
        >
          <ContrastTable />
        </ShowcaseGroup>
        <ShowcaseGroup
          title="Accent rotation"
          caption="Sky Blue, Yellow, Green, Coral: one per section, never the same three times in a row."
        >
          <RotationStats accent={accent} />
        </ShowcaseGroup>
      </div>
    ),
  },
  {
    match: /^typograph/i,
    render: () => (
      <div className="flex flex-col gap-12">
        <TypeSpecimen />
        <ShowcaseGroup title="Weights">
          <TypeWeights />
        </ShowcaseGroup>
        <ShowcaseGroup
          title="Reading width"
          caption="Paragraphs stop at prose-max."
        >
          <ProseMeasure />
        </ShowcaseGroup>
      </div>
    ),
  },
  { match: /^shape/i, render: ({ accent }) => <Shape accent={accent} /> },
  { match: /^(lines|separators|focus)\b/i, render: () => <LinesAndFocus /> },
  { match: /^layout/i, render: ({ accent }) => <AppShell accent={accent} /> },
  {
    match: /^elevation/i,
    render: ({ design }) => <Elevation rule={design.notes.elevation?.rule} />,
  },
  {
    match: /interface/i,
    render: ({ accent }) => <InterfaceComponents accent={accent} />,
  },
  {
    match: /statement/i,
    render: ({ accent }) => <StatementComponents accent={accent} />,
  },
  {
    match: /^do[’']?s and don[’']?ts/i,
    render: ({ body }) => <DosAndDonts markdown={body} />,
    ownsProse: true,
  },
]

/**
 * The page: the header, then the file's sections in its own order, each a layout from the library with
 * its prose one click away (a section no layout claims shows its prose), then the lint findings. Accents
 * rotate across the sections that show one, starting from the first.
 */
export function Showcase({ design }: { design: Design }) {
  const used = new Set<Module>()
  let accents = 0
  const sections = design.sections
    .filter((section) => section.heading !== "")
    .map((section) => {
      const layout = MODULES.find(
        (entry) => !used.has(entry) && entry.match.test(section.heading),
      )
      if (layout) used.add(layout)
      return {
        ...section,
        layout,
        accent: layout ? accentAt(accents++) : undefined,
        body: sectionBody(section.markdown),
      }
    })
  const ids = new Set<string>()
  const idOf = (heading: string) => {
    let id = sectionId(heading) || "section"
    while (ids.has(id)) id = `${id}-more`
    ids.add(id)
    return id
  }

  return (
    <main className="mx-auto w-full max-w-(--content-max) px-6">
      <ShowcaseHeader design={design} />
      {sections.map(({ heading, layout, accent, body }, index) => (
        <ShowcaseSection
          key={heading}
          id={idOf(heading)}
          number={index + 1}
          title={heading}
          accent={accent}
          prose={layout && !layout.ownsProse ? body : undefined}
        >
          {layout ? (
            layout.render({ design, accent: accent!, body })
          ) : (
            <Prose markdown={body} />
          )}
        </ShowcaseSection>
      ))}
      <ShowcaseSection
        id="lint"
        number={sections.length + 1}
        title="Lint"
        accent={accentAt(accents)}
      >
        <p className="type-body-sm text-muted-foreground max-w-(--prose-max)">
          Google’s official linter reads the base groups; the Answerable profile
          reads the rest and resolves the references the official linter reports
          as broken.
        </p>
        <FindingLists design={design} />
      </ShowcaseSection>
    </main>
  )
}
