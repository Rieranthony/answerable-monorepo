import { ArrowRightIcon } from "lucide-react"
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@answerable/ui/components/alert"
import { Badge } from "@answerable/ui/components/badge"
import { Button } from "@answerable/ui/components/button"
import {
  Card,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@answerable/ui/components/card"
import { Kbd } from "@answerable/ui/components/kbd"
import {
  Progress,
  ProgressLabel,
  ProgressValue,
} from "@answerable/ui/components/progress"
import { Skeleton } from "@answerable/ui/components/skeleton"

import { BENEFITS, PROGRAMME } from "./content"
import { NeutralTable, SizeChart } from "./data"
import { FormDemo, SurfaceDemo, TabsDemo, ToastDemo } from "./demos"
import type { Accent } from "./lib"
import { ShowcaseGroup } from "./section"
import { SidebarNav } from "./surfaces"

const VARIANTS = [
  "default",
  "secondary",
  "ghost",
  "link",
  "destructive",
  "accent",
] as const
const SIZES = ["sm", "default", "lg", "xl"] as const
const ICON_SIZES = ["icon-sm", "icon", "icon-lg"] as const

/** Every button variant at every size, the accent in the section's colour. */
function Buttons({ accent }: { accent: Accent }) {
  return (
    <div className="flex flex-col gap-4">
      {VARIANTS.map((variant) => (
        <div
          key={variant}
          className="grid items-center gap-3 sm:grid-cols-[8rem_1fr]"
        >
          <span className="type-caption text-muted-foreground font-mono">
            {variant}
          </span>
          <div className="flex flex-wrap items-center gap-3">
            {SIZES.map((size) => (
              <Button
                key={size}
                variant={variant}
                size={size}
                highlight={variant === "accent" ? accent : undefined}
              >
                {size}
              </Button>
            ))}
            {variant !== "link" &&
              ICON_SIZES.map((size) => (
                <Button
                  key={size}
                  variant={variant}
                  size={size}
                  highlight={variant === "accent" ? accent : undefined}
                  aria-label={`Continue, ${size}`}
                >
                  <ArrowRightIcon />
                </Button>
              ))}
          </div>
        </div>
      ))}
    </div>
  )
}

/** The interface layer: quiet, neutral, predictable. */
export function InterfaceComponents({ accent }: { accent: Accent }) {
  return (
    <div className="flex flex-col gap-12">
      <ShowcaseGroup
        title="Buttons"
        caption="Default, secondary, ghost, link and destructive at sm, default, lg and xl, then the icon sizes. The accent button belongs to the statement layer: one per screen."
      >
        <Buttons accent={accent} />
      </ShowcaseGroup>

      <ShowcaseGroup
        title="Forms"
        caption="Filled, square, no border. An invalid field takes a square marker beside its label; its message stays black."
      >
        <FormDemo />
      </ShowcaseGroup>

      <ShowcaseGroup
        title="Surfaces"
        caption="Card, dialog, dropdown menu, popover and tooltip."
      >
        <div className="bg-sidebar grid gap-6 p-6 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>{BENEFITS[1]!.lead}</CardTitle>
              <CardDescription>{BENEFITS[1]!.body}</CardDescription>
            </CardHeader>
            <CardFooter>
              <Button size="sm">{PROGRAMME.register}</Button>
            </CardFooter>
          </Card>
          <div className="flex flex-col justify-center gap-4">
            <SurfaceDemo />
          </div>
        </div>
      </ShowcaseGroup>

      <ShowcaseGroup
        title="Navigation"
        caption="Tabs on the muted fill, and the sidebar on neutral-50."
      >
        <div className="grid gap-6 lg:grid-cols-[auto_1fr]">
          <SidebarNav className="bg-sidebar w-(--sidebar-width) max-w-full" />
          <TabsDemo />
        </div>
      </ShowcaseGroup>

      <ShowcaseGroup
        title="Feedback"
        caption="Badges, alerts with their square marker, the toast, the skeleton and progress."
      >
        <div className="flex flex-wrap items-center gap-2">
          <Badge>Founding cohort</Badge>
          <Badge highlight={accent}>Accredited</Badge>
          <Kbd>⏎</Kbd>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <Alert variant="success">
            <AlertTitle>You’re on the list</AlertTitle>
            <AlertDescription>{PROGRAMME.registered}</AlertDescription>
          </Alert>
          <Alert variant="info">
            <AlertTitle>Places are limited</AlertTitle>
            <AlertDescription>{PROGRAMME.cohort}</AlertDescription>
          </Alert>
          <Alert variant="warning">
            <AlertTitle>Not a reservation</AlertTitle>
            <AlertDescription>{PROGRAMME.notReserved}</AlertDescription>
          </Alert>
          <Alert variant="destructive">
            <AlertTitle>Registration failed</AlertTitle>
            <AlertDescription>{PROGRAMME.failed}</AlertDescription>
          </Alert>
        </div>
        <div className="grid items-center gap-6 md:grid-cols-3">
          <ToastDemo />
          <div className="flex flex-col gap-2" aria-hidden="true">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-(--control-md) w-32" />
          </div>
          <Progress value={90}>
            <ProgressLabel>
              The interface layer’s share of a screen
            </ProgressLabel>
            <ProgressValue />
          </Progress>
        </div>
      </ShowcaseGroup>

      <ShowcaseGroup
        title="Data"
        caption="A table with tabular, right-aligned figures and a selected row, and a chart in the five chart colours."
      >
        <NeutralTable />
        <SizeChart />
      </ShowcaseGroup>
    </div>
  )
}
