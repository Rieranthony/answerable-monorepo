import * as React from "react"
import { Input as InputPrimitive } from "@base-ui/react/input"

import { inputClassName } from "@answerable/ui/lib/input"
import { cn } from "@answerable/ui/lib/utils"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      className={cn(inputClassName, className)}
      {...props}
    />
  )
}

export { Input }
