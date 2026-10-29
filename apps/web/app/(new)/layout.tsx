import type { Metadata, Viewport } from "next"
import { Public_Sans } from "next/font/google"

import "../globals.css"
import { FRAME_SCRIPT } from "@/components/new/image-column"
import { Splash, SPLASH_COLOUR_SCRIPT } from "@/components/new/splash"
import { createMetadata, SITE } from "@/lib/metadata"
import { cn } from "@answerable/ui/lib/utils"

const publicSans = Public_Sans({ subsets: ["latin"], variable: "--font-sans" })

export const metadata: Metadata = {
  ...createMetadata({ pathname: "/new" }),
  alternates: undefined,
  metadataBase: new URL(SITE.origin),
  title: { default: SITE.name, template: "%s · Answerable" },
}

// This root is light only, like the design pages; the splash is the one place
// an accent fills the screen.
export const viewport: Viewport = { colorScheme: "light" }

export default function NewLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    // The scripts below set `--splash`, `--gutter` and `--frame` on <html>
    // before first paint, which the server HTML cannot match. The scrollbar's gutter is always kept, so
    // opening a section that makes the page scroll never narrows the columns.
    <html
      lang="en"
      className={cn(
        "[scrollbar-gutter:stable] font-sans antialiased",
        publicSans.variable,
      )}
      suppressHydrationWarning
    >
      <body>
        <script dangerouslySetInnerHTML={{ __html: SPLASH_COLOUR_SCRIPT }} />
        <script dangerouslySetInnerHTML={{ __html: FRAME_SCRIPT }} />
        <Splash />
        {children}
      </body>
    </html>
  )
}
