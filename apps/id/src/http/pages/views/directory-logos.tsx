import {
  MICROSOFT_LOGO,
  GOOGLE_LOGO,
} from "@answerable/ui/lib/directory-logos";
import { DirectoryLogo } from "../ui/directory-logo.tsx";
export function DirectoryLogos() {
  const directories = [
    {
      name: "Microsoft Entra ID",
      mark: MICROSOFT_LOGO,
    },
    {
      name: "Google Workspace",
      mark: GOOGLE_LOGO,
    },
  ];
  return (
    <footer class="flex flex-col items-center gap-2 self-end text-center">
      <p id="supported-directories" class="text-muted-foreground text-xs/4">
        Works with
      </p>
      <ul
        aria-labelledby="supported-directories"
        class="flex flex-wrap items-center justify-center gap-x-6 gap-y-2"
      >
        {directories.map(({ name, mark }) => (
          <li class="flex items-center gap-2 text-sm/6">
            <DirectoryLogo mark={mark} class="size-4 shrink-0" />
            <span>{name}</span>
          </li>
        ))}
      </ul>
    </footer>
  );
}
