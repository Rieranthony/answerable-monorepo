import { DocsLayout } from "fumadocs-ui/layouts/notebook"
import { RootProvider } from "fumadocs-ui/provider/next"

import { baseOptions } from "@/lib/layout.shared"
import { source } from "@/lib/source"

export const metadata = {
  robots: { index: false, follow: true },
  title: {
    default: "Answerable docs",
    template: "%s · Answerable docs",
  },
}

// The root layout is dark only, so Fumadocs' own theme switching stays off.
export default function Layout({ children }: LayoutProps<"/docs">) {
  return (
    <RootProvider theme={{ enabled: false }}>
      <DocsLayout tree={source.getPageTree()} {...baseOptions()}>
        {children}
      </DocsLayout>
    </RootProvider>
  )
}
