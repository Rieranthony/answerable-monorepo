import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared"

import { Logo } from "@/components/logo"

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <span className="flex items-center gap-2">
          <Logo className="h-auto w-20" />
          <span className="text-muted-foreground text-sm">Docs</span>
        </span>
      ),
      url: "/docs",
    },
    links: [{ text: "Home", url: "/" }],
  }
}
