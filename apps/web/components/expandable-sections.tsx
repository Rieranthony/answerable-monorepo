"use client"

import type { ReactNode } from "react"
import { Accordion } from "@base-ui/react/accordion"

import { SquareChevron } from "@/components/square-chevron"

type ExpandableSectionsProps = {
  children: ReactNode
}

type ExpandableSectionProps = {
  value: string
  title: string
  children: ReactNode
}

export function ExpandableSections({ children }: ExpandableSectionsProps) {
  return (
    <Accordion.Root keepMounted className="-my-2 flex flex-col">
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
        <Accordion.Trigger className="group focus-visible:ring-ring/50 flex w-full cursor-pointer items-start gap-2 py-2 text-left outline-none focus-visible:ring-2">
          <SquareChevron />
          <span>{title}</span>
        </Accordion.Trigger>
      </Accordion.Header>
      <Accordion.Panel className="h-(--accordion-panel-height) overflow-hidden transition-[height,opacity] duration-200 ease-[cubic-bezier(0.2,0,0,1)] data-ending-style:h-0 data-ending-style:opacity-0 data-starting-style:h-0 data-starting-style:opacity-0 motion-reduce:transition-none">
        <div className="flex flex-col gap-4 pb-2 pl-6">{children}</div>
      </Accordion.Panel>
    </Accordion.Item>
  )
}
