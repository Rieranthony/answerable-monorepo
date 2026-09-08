import type { Metadata } from "next"
import { Public_Sans } from "next/font/google"

import "./globals.css"
import { ThemeProvider } from "@/components/theme-provider"
import { createMetadata, SITE } from "@/lib/metadata"
import { cn } from "@/lib/utils"

const publicSans = Public_Sans({ subsets: ["latin"], variable: "--font-sans" })

export const metadata: Metadata = {
  ...createMetadata({ pathname: "/" }),
  alternates: undefined,
  metadataBase: new URL(SITE.origin),
  title: { default: SITE.name, template: "%s · Answerable" },
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={cn("font-sans antialiased", publicSans.variable)}
    >
      <body>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  )
}
