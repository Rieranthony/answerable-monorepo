"use client"

import { useState, type ReactNode } from "react"

import { ExpandableSections } from "@/components/expandable-sections"
import { FramedImage } from "@/components/new/framed-image"
import { isFramingKey, type FramingKey } from "@/components/new/framings"
import { ImageColumn } from "@/components/new/image-column"

type LandingProps = {
  header: ReactNode
  hero: ReactNode
  /** The `ExpandableSection`s; their values are framing keys. */
  children: ReactNode
  join: ReactNode
  footer: ReactNode
}

/**
 * Owns which section is open, because the image column follows it. The copy
 * arrives as server-rendered props; only the open value lives here. Nothing
 * open shows the hero framing.
 */
export function Landing({
  header,
  hero,
  children,
  join,
  footer,
}: LandingProps) {
  const [active, setActive] = useState<FramingKey>("hero")

  return (
    <div className="lg:grid lg:grid-cols-2">
      <div className="flex min-h-svh flex-col px-6 lg:px-12">
        <div className="mx-auto flex w-full max-w-[560px] grow flex-col">
          {header}

          {/* Phones: the hero framing as a band under the header, edge to edge. */}
          <div className="relative -mx-6 aspect-[4/3] lg:hidden">
            <FramedImage framing="hero" eager />
          </div>

          <main className="mt-12 flex flex-col gap-12 lg:mt-16 lg:gap-16">
            {hero}
            <div>
              <p className="text-muted-foreground text-sm/6">
                Click to expand below:
              </p>
              <div className="mt-2">
                <ExpandableSections
                  onValueChange={(value) => {
                    const open = value[0]
                    setActive(isFramingKey(open) ? open : "hero")
                  }}
                >
                  {children}
                </ExpandableSections>
              </div>
            </div>
            {join}
          </main>

          {footer}
        </div>
      </div>

      <div className="hidden lg:block">
        <ImageColumn active={active} />
      </div>
    </div>
  )
}
