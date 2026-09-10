"use client"

import type { MouseEvent, ReactNode } from "react"
import { Accordion } from "@base-ui/react/accordion"

import { SquareChevron } from "@/components/square-chevron"
import { scrollTargetForOpeningHeader } from "@/lib/expand-scroll"

const HEADER_TOP_MARGIN = 16

type ExpandableSectionsProps = {
  children: ReactNode
}

type ExpandableSectionProps = {
  value: string
  title: string
  children: ReactNode
}

/** Runs before the accordion updates, so the DOM still shows what is open. */
function keepHeaderOnScreen(event: MouseEvent<HTMLButtonElement>) {
  const trigger = event.currentTarget
  if (trigger.hasAttribute("data-panel-open")) return

  const headerTop = trigger.getBoundingClientRect().top
  const openPanel = trigger
    .closest("[data-expandable-sections]")
    ?.querySelector("[data-expandable-panel][data-open]")
  const panelRect = openPanel?.getBoundingClientRect()
  const collapsingHeightAbove =
    panelRect && panelRect.top < headerTop ? panelRect.height : 0

  const top = scrollTargetForOpeningHeader({
    headerTop,
    collapsingHeightAbove,
    scrollY: window.scrollY,
    margin: HEADER_TOP_MARGIN,
  })
  if (top === null) return

  const reduceMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)",
  ).matches
  window.scrollTo({ top, behavior: reduceMotion ? "instant" : "smooth" })
}

export function ExpandableSections({ children }: ExpandableSectionsProps) {
  return (
    <Accordion.Root
      keepMounted
      data-expandable-sections
      className="-my-2 flex flex-col"
    >
      {children}
    </Accordion.Root>
  )
}

export function ExpandableSection({
  value,
  title,
  children,
}: ExpandableSectionProps) {
  return (
    <Accordion.Item value={value}>
      <Accordion.Header render={<h2 />} className="text-sm/6 font-bold">
        <Accordion.Trigger
          onClick={keepHeaderOnScreen}
          className="group focus-visible:ring-ring/50 flex w-full cursor-pointer items-start gap-2 py-2 text-left outline-none focus-visible:ring-2"
        >
          <span className="grow">{title}</span>
          <SquareChevron />
        </Accordion.Trigger>
      </Accordion.Header>
      <Accordion.Panel
        data-expandable-panel
        className="h-(--accordion-panel-height) overflow-hidden transition-[height,opacity] duration-200 ease-[cubic-bezier(0.2,0,0,1)] data-ending-style:h-0 data-ending-style:opacity-0 data-starting-style:h-0 data-starting-style:opacity-0 motion-reduce:transition-none"
      >
        <div className="flex flex-col gap-4 pb-2">{children}</div>
      </Accordion.Panel>
    </Accordion.Item>
  )
}
