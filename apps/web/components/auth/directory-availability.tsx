"use client"

import { useEffect, useState, type ComponentType } from "react"

import { GoogleLogo } from "@answerable/ui/components/google-logo"
import { MicrosoftLogo } from "@answerable/ui/components/microsoft-logo"
import { cn } from "@answerable/ui/lib/utils"
import {
  DIRECTORIES,
  readPlatformApplications,
  type PlatformApplications,
} from "@/lib/auth/platform-applications"

const LOGOS: Record<
  keyof PlatformApplications,
  ComponentType<{ className?: string }>
> = {
  microsoft: MicrosoftLogo,
  google: GoogleLogo,
}

/**
 * The company accounts Answerable ID can sign people in with. One without
 * platform credentials is greyed out; nothing renders until the answer is known.
 */
export function DirectoryAvailability({ className }: { className?: string }) {
  const [applications, setApplications] = useState<PlatformApplications | null>(
    null,
  )

  useEffect(() => {
    let active = true

    void readPlatformApplications(process.env.NEXT_PUBLIC_ID_URL).then(
      (result) => {
        if (active) setApplications(result)
      },
    )

    return () => {
      active = false
    }
  }, [])

  if (!applications) return null

  return (
    <footer
      className={cn("flex flex-col items-center gap-2 text-center", className)}
    >
      <p
        id="directory-availability"
        className="text-muted-foreground text-xs/4"
      >
        Works with
      </p>
      <ul
        aria-labelledby="directory-availability"
        className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2"
      >
        {DIRECTORIES.map(({ application, name }) => {
          const available = applications[application]
          const Logo = LOGOS[application]
          return (
            <li
              key={application}
              className={cn(
                "flex items-center gap-2 text-sm/6",
                !available && "text-muted-foreground",
              )}
            >
              <Logo className={cn(!available && "opacity-40 grayscale")} />
              <span>{name}</span>
              {!available && <span className="text-xs/4">Not available</span>}
            </li>
          )
        })}
      </ul>
    </footer>
  )
}
