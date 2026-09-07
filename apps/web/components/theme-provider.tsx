"use client"

import * as React from "react"
import { usePathname } from "next/navigation"
import { ThemeProvider as NextThemesProvider } from "next-themes"

// The docs are always dark; the rest of the site follows the visitor's choice.
function isDocsPath(pathname: string) {
  return pathname === "/docs" || pathname.startsWith("/docs/")
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
      forcedTheme={isDocsPath(pathname) ? "dark" : undefined}
      {...props}
    >
      {children}
    </NextThemesProvider>
  )
}

export { ThemeProvider }
