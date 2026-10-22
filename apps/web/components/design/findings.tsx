import type { Design, Finding } from "@answerable/design"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@answerable/ui/components/table"
import { cn } from "@answerable/ui/lib/utils"

const SEVERITIES = ["error", "warning", "info"] as const

/**
 * The two verdicts. The official list as Google's CLI reports it: the parser moves each `broken-ref` error
 * the profile resolves into the profile's list as a `profile-resolved-reference` info, so those count
 * here again as the official errors they are.
 */
export function verdicts(design: Design) {
  const resolved = design.findings.profile.filter(
    (finding) => finding.rule === "profile-resolved-reference",
  )
  const official: Finding[] = [
    ...resolved.map((finding) => ({
      ...finding,
      severity: "error" as const,
      rule: "broken-ref",
    })),
    ...design.findings.official,
  ]
  return [
    {
      id: "profile",
      title: "Answerable profile",
      findings: design.findings.profile,
    },
    { id: "official", title: "Official linter", findings: official },
  ]
}

function count(findings: readonly Finding[]) {
  return SEVERITIES.map((severity) => {
    const n = findings.filter((f) => f.severity === severity).length
    return `${n} ${severity === "info" ? "info" : n === 1 ? severity : `${severity}s`}`
  }).join(" · ")
}

/** `Answerable profile: 0 errors · 0 warnings · 20 info`, one line per linter. */
export function VerdictCounts({ design }: { design: Design }) {
  return (
    <dl className="type-ui-text grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
      {verdicts(design).map(({ id, title, findings }) => (
        <div key={id} className="contents">
          <dt className="type-label">{title}</dt>
          <dd className="text-muted-foreground type-numeric">
            {count(findings)}
          </dd>
        </div>
      ))}
    </dl>
  )
}

/** Every finding with its path: one table per linter, each behind its own toggle. */
export function FindingLists({ design }: { design: Design }) {
  return (
    <div className="flex flex-col gap-4">
      {verdicts(design).map(({ id, title, findings }) => (
        <details key={id} className="group/findings bg-muted">
          <summary className="focus-visible:focus-ring flex cursor-default list-none items-baseline justify-between gap-4 p-4 outline-none [&::-webkit-details-marker]:hidden">
            <span className="type-label">{title}</span>
            <span className="type-caption text-muted-foreground type-numeric">
              {count(findings)}
              <span className="ml-2 group-open/findings:hidden">Show</span>
              <span className="ml-2 hidden group-open/findings:inline">
                Hide
              </span>
            </span>
          </summary>
          <div className="bg-background">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Severity</TableHead>
                  <TableHead>Rule</TableHead>
                  <TableHead>Path</TableHead>
                  <TableHead>Message</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {findings.map((finding, index) => (
                  <TableRow key={index}>
                    <TableCell
                      className={cn(
                        finding.severity === "error" && "type-label",
                      )}
                    >
                      {finding.severity}
                    </TableCell>
                    <TableCell className="font-mono text-[0.9em]">
                      {finding.rule ?? "none"}
                    </TableCell>
                    <TableCell className="font-mono text-[0.9em]">
                      {finding.path ?? "none"}
                    </TableCell>
                    <TableCell className="min-w-80 whitespace-normal">
                      {finding.message}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </details>
      ))}
    </div>
  )
}
