import { DocsLayout } from "fumadocs-ui/layouts/notebook"
import { RootProvider } from "fumadocs-ui/provider/next"

import { baseOptions } from "@/lib/layout.shared"
import { source } from "@/lib/source"

export const metadata = {
  title: {
    default: "Answerable docs",
    template: "%s · Answerable docs",
  },
}

// Theme is owned by next-themes in the root layout, which forces dark on /docs.
export default function Layout({ children }: LayoutProps<"/docs">) {
  return (
    <RootProvider theme={{ enabled: false }}>
      <DocsLayout tree={source.getPageTree()} {...baseOptions()}>
        {children}
      </DocsLayout>
    </RootProvider>
  )
}
