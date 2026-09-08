"use client"

import * as React from "react"
import { usePathname } from "next/navigation"
import { ThemeProvider as NextThemesProvider } from "next-themes"

// The landing page and the docs are dark only, for now; the Answerable ID
// pages follow the visitor's choice.
function isForcedDark(pathname: string) {
  return (
    pathname === "/" || pathname === "/docs" || pathname.startsWith("/docs/")
  )
}

function ThemeProvider({
  children,
  ...props
}: React.ComponentProps<typeof NextThemesProvider>) {
  const pathname = usePathname()

  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
      forcedTheme={isForcedDark(pathname) ? "dark" : undefined}
      {...props}
    >
      {children}
    </NextThemesProvider>
  )
}

export { ThemeProvider }
