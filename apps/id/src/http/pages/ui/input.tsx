import type { JSX } from "hono/jsx";
import { inputClassName } from "@answerable/ui/lib/input";
import { cn } from "@answerable/ui/lib/utils";

export function Input({
  class: className,
  ...props
}: JSX.IntrinsicElements["input"]) {
  return (
    <input {...props} class={cn(inputClassName, className)} data-slot="input" />
  );
}
