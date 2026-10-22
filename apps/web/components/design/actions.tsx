"use client"

import { useEffect, useRef, useState } from "react"
import { CheckIcon, CopyIcon, DownloadIcon } from "lucide-react"
import { useDesign } from "@answerable/design/react"
import { Button } from "@answerable/ui/components/button"

/** Copies text, and says so on the button for two seconds. */
export function useCopy() {
  const [copied, setCopied] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  return {
    copied,
    copy: async (key: string, text: string) => {
      await navigator.clipboard.writeText(text)
      setCopied(key)
      clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(null), 2000)
    },
  }
}

/** Copy CSS, Copy DESIGN.md and Download: the design as it stands, the pane's edits written in. */
export function DesignActions({
  size = "default",
}: {
  size?: "sm" | "default"
}) {
  const design = useDesign()
  const { copied, copy } = useCopy()

  function download() {
    const url = URL.createObjectURL(
      new Blob([design.markdown], { type: "text/markdown;charset=utf-8" }),
    )
    const link = document.createElement("a")
    link.href = url
    link.download = "DESIGN.md"
    link.click()
    URL.revokeObjectURL(url)
  }

  return (
    <>
      <Button
        variant="secondary"
        size={size}
        onClick={() => copy("css", design.css)}
      >
        {copied === "css" ? <CheckIcon /> : <CopyIcon />}
        {copied === "css" ? "Copied" : "Copy CSS"}
      </Button>
      <Button
        variant="secondary"
        size={size}
        onClick={() => copy("markdown", design.markdown)}
      >
        {copied === "markdown" ? <CheckIcon /> : <CopyIcon />}
        {copied === "markdown" ? "Copied" : "Copy DESIGN.md"}
      </Button>
      <Button variant="secondary" size={size} onClick={download}>
        <DownloadIcon />
        Download
      </Button>
    </>
  )
}

/** Opens the findings at the foot of the page and takes the reader there. */
export function ShowFindings() {
  return (
    <Button
      variant="link"
      onClick={() => {
        const lint = document.getElementById("lint")
        lint
          ?.querySelectorAll("details")
          .forEach((details) => (details.open = true))
        lint?.scrollIntoView({
          behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
            ? "auto"
            : "smooth",
        })
      }}
    >
      Show the findings
    </Button>
  )
}
