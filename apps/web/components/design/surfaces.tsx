import { Avatar, AvatarFallback } from "@answerable/ui/components/avatar"
import { Badge } from "@answerable/ui/components/badge"
import { Button } from "@answerable/ui/components/button"
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@answerable/ui/components/card"
import { Checkbox } from "@answerable/ui/components/checkbox"
import { Input } from "@answerable/ui/components/input"
import {
  RadioGroup,
  RadioGroupItem,
} from "@answerable/ui/components/radio-group"
import { Separator } from "@answerable/ui/components/separator"
import { StatementDivider } from "@answerable/ui/components/statement/statement-divider"
import { Switch } from "@answerable/ui/components/switch"
import { cn } from "@answerable/ui/lib/utils"

import { BENEFITS, PROGRAMME, SECTIONS, VALUES } from "./content"
import { ACCENT_FILL, type Accent } from "./lib"
import { TokenValue } from "./readouts"
import { ShowcaseGroup } from "./section"

function Token({ name }: { name: string }) {
  return (
    <code className="bg-muted px-1 font-mono text-[0.9em]">
      {name}: <TokenValue name={name} />
    </code>
  )
}

/** Square controls at the design's radius, and the two shapes round by function. */
export function Shape({ accent }: { accent: Accent }) {
  return (
    <div className="grid gap-10 md:grid-cols-2">
      <ShowcaseGroup
        title="Square"
        caption={
          <>
            Every button, input, card, badge and accent element:{" "}
            <Token name="radius" />
          </>
        }
      >
        <div className="flex flex-wrap items-center gap-4">
          <Button>{PROGRAMME.register}</Button>
          <Badge>Founding cohort</Badge>
          <Badge highlight={accent}>Accredited</Badge>
          <Checkbox defaultChecked aria-label="Checked" />
          <Switch defaultChecked aria-label="On" />
        </div>
        <Input aria-label="Email" placeholder="you@practice.com" />
        <Card variant="muted">
          <CardHeader>
            <CardTitle>{SECTIONS[0]}</CardTitle>
            <CardDescription>{PROGRAMME.role[0]}</CardDescription>
          </CardHeader>
        </Card>
      </ShowcaseGroup>
      <ShowcaseGroup
        title="Round by function"
        caption={
          <>
            Radio buttons and avatars only, never accent-filled:{" "}
            <Token name="radius-full" />
          </>
        }
      >
        <RadioGroup defaultValue="lead" aria-label="Your role">
          <label className="type-ui-text flex items-center gap-2">
            <RadioGroupItem value="lead" />I am stepping into the AI Lead role
          </label>
          <label className="type-ui-text flex items-center gap-2">
            <RadioGroupItem value="colleague" />I am supporting a colleague who
            is
          </label>
        </RadioGroup>
        <div className="flex items-center gap-2">
          <Avatar>
            <AvatarFallback>KR</AvatarFallback>
          </Avatar>
          <Avatar>
            <AvatarFallback>SM</AvatarFallback>
          </Avatar>
          <span className="type-caption text-muted-foreground">
            Keir Regan-Alexander and Sadie Morgan OBE
          </span>
        </div>
      </ShowcaseGroup>
    </div>
  )
}

/** The two kinds of line and the focus ring. */
export function LinesAndFocus() {
  return (
    <div className="grid gap-10 md:grid-cols-2">
      <ShowcaseGroup
        title="Interface separator"
        caption={
          <>
            Between rows and groups, never around them:{" "}
            <Token name="line-separator-width" />
          </>
        }
      >
        <ol className="flex flex-col">
          {VALUES.slice(0, 4).map((value, index) => (
            <li key={value}>
              {index > 0 && <Separator />}
              <p className="type-ui-text flex gap-3 py-3">
                <span className="text-muted-foreground type-numeric">
                  {index + 1}
                </span>
                {value}
              </p>
            </li>
          ))}
        </ol>
      </ShowcaseGroup>
      <ShowcaseGroup
        title="Statement divider"
        caption="Major editorial breaks on statement pages and slides, in black."
      >
        {(
          [
            ["standard", "line-statement-width"],
            ["emphasis", "line-statement-emphasis-width"],
            ["heavy", "line-statement-heavy-width"],
          ] as const
        ).map(([weight, token]) => (
          <div key={weight} className="flex flex-col gap-2">
            <StatementDivider weight={weight} />
            <p className="type-caption text-muted-foreground">
              <span className="capitalize">{weight}</span>,{" "}
              <TokenValue name={token} />
            </p>
          </div>
        ))}
      </ShowcaseGroup>
      <ShowcaseGroup
        title="Focus ring"
        caption={
          <>
            On <code className="font-mono">:focus-visible</code> for every
            interactive element; press Tab to move it:{" "}
            <Token name="focus-ring" />
          </>
        }
        className="md:col-span-2"
      >
        <div className="flex flex-wrap items-center gap-6 p-2">
          {/* Drawn as focused, so the ring shows without a keyboard. */}
          <Button tabIndex={-1} className="focus-ring">
            {PROGRAMME.register}
          </Button>
          <Input
            tabIndex={-1}
            aria-label="Email, shown focused"
            defaultValue="you@practice.com"
            className="bg-background focus-ring w-64"
          />
          <Checkbox
            tabIndex={-1}
            defaultChecked
            aria-label="Checked, shown focused"
            className="focus-ring"
          />
        </div>
      </ShowcaseGroup>
    </div>
  )
}

const LEVELS = [
  ["xs", "shadow-xs", "Cards on neutral-50 shells, active tab, switch thumb"],
  ["sm", "shadow-sm", "Sticky headers, raised cards on hover"],
  ["md", "shadow-md", "Dropdowns, popovers, comboboxes"],
  ["lg", "shadow-lg", "Dialogs, toasts, sheets"],
] as const

/** The four levels on the shell's fill, beside a flat statement panel. */
export function Elevation({ rule }: { rule?: string }) {
  return (
    <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
      <div className="bg-sidebar grid gap-6 p-6 sm:grid-cols-2">
        {LEVELS.map(([level, shadow, use]) => (
          <div
            key={level}
            className={cn("bg-card flex flex-col gap-2 p-6", shadow)}
          >
            <span className="type-label">{level}</span>
            <span className="type-body-sm text-muted-foreground">{use}</span>
            <code className="type-caption text-muted-foreground">
              <TokenValue name={`elevation-${level}`} />
            </code>
          </div>
        ))}
      </div>
      <div className="bg-surface-dark text-on-dark flex flex-col justify-end gap-4 p-10">
        <span className="type-statement-md">Flat</span>
        <p className="type-body-md">
          Statement panels take their contrast from solid black and white, not
          shadow.
        </p>
        {rule && <p className="type-body-sm">{rule}</p>}
      </div>
    </div>
  )
}

/** The sidebar of the app shell: eyebrow group label, 36px items, the active one filled and Bold. */
export function SidebarNav({ className }: { className?: string }) {
  return (
    <nav
      aria-label="Programme"
      className={cn("flex flex-col gap-1 p-3", className)}
    >
      <p className="type-eyebrow text-muted-foreground px-3 pt-2 pb-1">
        Programme
      </p>
      {SECTIONS.map((section, index) => (
        <a
          key={section}
          href="#layout"
          aria-current={index === 0 ? "page" : undefined}
          className="type-nav-link duration-fast hover:bg-sidebar-accent focus-visible:focus-ring aria-[current=page]:bg-border aria-[current=page]:type-nav-link-active flex min-h-(--control-md) items-center px-3 py-2 transition-colors outline-none"
        >
          {section}
        </a>
      ))}
    </nav>
  )
}

/** The app shell: the top nav, the sidebar and the content, both cards on their surfaces. */
export function AppShell({ accent }: { accent: Accent }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="bg-background overflow-hidden shadow-md">
        <div className="flex h-(--nav-height) items-center justify-between gap-4 px-6">
          <p className="type-heading-h4">{SECTIONS[3]}</p>
          <Button size="sm">{PROGRAMME.register}</Button>
        </div>
        <Separator />
        <div className="flex">
          <SidebarNav className="bg-sidebar hidden w-(--sidebar-width) shrink-0 md:flex" />
          <div className="grid min-w-0 flex-1 lg:grid-cols-2">
            <div className="bg-sidebar flex flex-col gap-3 p-6">
              <p className="type-caption text-muted-foreground">
                card, on the neutral-50 shell
              </p>
              <Card>
                <CardHeader>
                  <CardTitle>{BENEFITS[0]!.lead}</CardTitle>
                  <CardDescription>{BENEFITS[0]!.body}</CardDescription>
                </CardHeader>
              </Card>
            </div>
            <div className="flex flex-col gap-3 p-6">
              <p className="type-caption text-muted-foreground">
                card-muted, on white
              </p>
              <Card variant="muted">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <span
                      aria-hidden="true"
                      className={cn("size-2 shrink-0", ACCENT_FILL[accent])}
                    />
                    {BENEFITS[2]!.lead}
                  </CardTitle>
                  <CardDescription>{BENEFITS[2]!.body}</CardDescription>
                </CardHeader>
              </Card>
            </div>
          </div>
        </div>
      </div>
      <p className="type-caption text-muted-foreground flex flex-wrap gap-x-4 gap-y-1">
        <Token name="nav-height" />
        <Token name="sidebar-width" />
        <Token name="content-max" />
        <Token name="prose-max" />
      </p>
    </div>
  )
}
