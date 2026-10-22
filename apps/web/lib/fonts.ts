import { Public_Sans } from "next/font/google"

/**
 * Public Sans, self-hosted for the design pages. The pane wears the default design, whose stack names a
 * bare "Public Sans"; it is handed next/font's own stack instead, with the metric-matched fallback.
 */
export const publicSans = Public_Sans({ subsets: ["latin"] })
