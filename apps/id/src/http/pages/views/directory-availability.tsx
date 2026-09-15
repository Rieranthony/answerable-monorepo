import {
  MICROSOFT_LOGO,
  GOOGLE_LOGO,
} from "@answerable/ui/lib/directory-logos";
import type { PlatformApplications } from "../../../auth/platform-applications.ts";
import { DirectoryLogo } from "../ui/directory-logo.tsx";
export function DirectoryAvailability({
  applications,
}: {
  applications: PlatformApplications;
}) {
  const directories = [
    {
      name: "Microsoft Entra ID",
      mark: MICROSOFT_LOGO,
      available: applications.microsoft !== undefined,
    },
    {
      name: "Google Workspace",
      mark: GOOGLE_LOGO,
      available: applications.google !== undefined,
    },
  ];
  return (
    <footer class="flex flex-col items-center gap-2 self-end text-center">
      <p id="directory-availability" class="text-muted-foreground text-xs/4">
        Works with
      </p>
      <ul
        aria-labelledby="directory-availability"
        class="flex flex-wrap items-center justify-center gap-x-6 gap-y-2"
      >
        {directories.map(({ name, mark, available }) => (
          <li
            class={`flex items-center gap-2 text-sm/6${available ? "" : " text-muted-foreground"}`}
          >
            <DirectoryLogo
              mark={mark}
              class={`size-4 shrink-0${available ? "" : " opacity-40 grayscale"}`}
            />
            <span>{name}</span>
            {!available && <span class="text-xs/4">Not available</span>}
          </li>
        ))}
      </ul>
    </footer>
  );
}
