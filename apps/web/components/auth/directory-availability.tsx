import { cn } from "@answerable/ui/lib/utils"
import {
  DIRECTORIES,
  type PlatformApplications,
} from "@/lib/auth/platform-applications"

interface DirectoryAvailabilityProps {
  applications: PlatformApplications
}

/** The company accounts Answerable ID accepts; unavailable ones are greyed out. */
export function DirectoryAvailability({
  applications,
}: DirectoryAvailabilityProps) {
  return (
    <div className="mt-8">
      <p
        id="directory-availability"
        className="text-muted-foreground text-xs/4"
      >
        Works with
      </p>
      <ul
        aria-labelledby="directory-availability"
        className="mt-2 flex flex-col gap-2"
      >
        {DIRECTORIES.map(({ application, name }) => {
          const available = applications[application]
          return (
            <li
              key={application}
              className={cn(
                "flex items-center gap-2 text-sm/6",
                !available && "text-muted-foreground",
              )}
            >
              <span
                aria-hidden="true"
                className={cn(
                  "size-2 shrink-0",
                  available ? "bg-foreground" : "bg-muted",
                )}
              />
              <span className="grow">{name}</span>
              {!available && <span className="text-xs/4">Not available</span>}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
