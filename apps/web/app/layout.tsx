import type { Metadata, Viewport } from "next"
import { Public_Sans } from "next/font/google"

import "./globals.css"
import { createMetadata, SITE } from "@/lib/metadata"
import { cn } from "@answerable/ui/lib/utils"

const publicSans = Public_Sans({ subsets: ["latin"], variable: "--font-sans" })

export const metadata: Metadata = {
  ...createMetadata({ pathname: "/" }),
  alternates: undefined,
  metadataBase: new URL(SITE.origin),
  title: { default: SITE.name, template: "%s · Answerable" },
}

// The site is dark only: the class is static, so the server HTML is already
// dark and needs no script, and the browser draws its own controls and
// scrollbars dark too.
export const viewport: Viewport = { colorScheme: "dark" }

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html
      lang="en"
      className={cn("dark font-sans antialiased", publicSans.variable)}
    >
      <body>{children}</body>
    </html>
  )
}
