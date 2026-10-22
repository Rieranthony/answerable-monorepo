import type { Metadata, Viewport } from "next"
import { Public_Sans } from "next/font/google"

import "./globals.css"
import { cn } from "@answerable/ui/lib/utils"

// Two root layouts leave no layout to wrap a URL that matches no route, so this page carries the site's
// own dark one, as the 404 did before the design page had its own root.
const publicSans = Public_Sans({ subsets: ["latin"], variable: "--font-sans" })

export const metadata: Metadata = {
  title: "404: This page could not be found.",
}

export const viewport: Viewport = { colorScheme: "dark" }

export default function GlobalNotFound() {
  return (
    <html
      lang="en"
      className={cn("dark font-sans antialiased", publicSans.variable)}
    >
      <body>
        <main className="flex min-h-svh items-center justify-center gap-4 px-6">
          <h1 className="text-xl font-bold">404</h1>
          <p className="text-muted-foreground text-sm">
            This page could not be found.
          </p>
        </main>
      </body>
    </html>
  )
}
