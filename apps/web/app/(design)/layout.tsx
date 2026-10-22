import type { Metadata, Viewport } from "next"
import {
  DesignFonts,
  DesignProvider,
  DesignVars,
} from "@answerable/design/react"

import "../globals.css"
import { loadDesign } from "@/lib/design"
import { publicSans } from "@/lib/fonts"
import { SITE } from "@/lib/metadata"

export const metadata: Metadata = { metadataBase: new URL(SITE.origin) }

// The design pages are light: they show DESIGN.md as written, and its light
// scheme is the only one the profile describes.
export const viewport: Viewport = { colorScheme: "light" }

export default function DesignLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" className="antialiased">
      <body>
        {/* Public Sans is handed to the provider rather than set as a class, so
            the font stays a hook the design can override. */}
        <DesignProvider
          design={loadDesign()}
          fonts={{ "Public Sans": publicSans.style.fontFamily }}
        >
          <DesignVars />
          <DesignFonts />
          {children}
        </DesignProvider>
      </body>
    </html>
  )
}
