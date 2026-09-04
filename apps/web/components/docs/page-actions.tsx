"use client"

import { Check, Copy } from "lucide-react"
import { useEffect, useRef, useState } from "react"

import { Button } from "@/components/ui/button"

export function PageActions({ pageUrl }: { pageUrl: string }) {
  const [copied, setCopied] = useState(false)
  const resetTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const markdownUrl = `${pageUrl}.md`

  useEffect(() => {
    return () => clearTimeout(resetTimer.current)
  }, [])

  async function copyMarkdown() {
    const response = await fetch(markdownUrl)

    if (!response.ok) return

    await navigator.clipboard.writeText(await response.text())
    setCopied(true)
    clearTimeout(resetTimer.current)
    resetTimer.current = setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="mt-3 flex items-center gap-2">
      <Button variant="outline" size="xs" type="button" onClick={copyMarkdown}>
        {copied ? <Check /> : <Copy />}
        {copied ? "Copied" : "Copy Markdown"}
      </Button>
      <Button
        variant="outline"
        size="xs"
        nativeButton={false}
        render={<a href={markdownUrl} />}
      >
        View as Markdown
      </Button>
    </div>
  )
}
