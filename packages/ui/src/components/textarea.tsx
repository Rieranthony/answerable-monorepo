import * as React from "react"

import { inputClassName } from "@answerable/ui/lib/input"
import { cn } from "@answerable/ui/lib/utils"

/** The input's filled look, at least 96px tall, growing with its content. */
function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        inputClassName,
        "flex field-sizing-content h-auto min-h-24 py-2",
        className,
      )}
      {...props}
    />
  )
}

export { Textarea }
