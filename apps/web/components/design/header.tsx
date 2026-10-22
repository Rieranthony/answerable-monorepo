import type { Design } from "@answerable/design"
import { Badge } from "@answerable/ui/components/badge"

import { DesignActions, ShowFindings } from "./actions"
import { VerdictCounts } from "./findings"

/** The design's metadata, the two lint verdicts and the exports. */
export function ShowcaseHeader({ design }: { design: Design }) {
  return (
    <header className="flex flex-col gap-8 pt-16 pb-8">
      <div className="flex flex-col gap-4">
        <p className="type-eyebrow text-muted-foreground flex items-center gap-2">
          DESIGN.md
          <Badge>Version {design.version}</Badge>
        </p>
        <h1 className="type-heading-h1">{design.name}</h1>
        <p className="type-body-md max-w-(--prose-max)">{design.description}</p>
      </div>
      <div className="flex flex-col gap-2">
        <VerdictCounts design={design} />
        <div>
          <ShowFindings />
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <DesignActions />
      </div>
    </header>
  )
}
