import type { JSX } from "hono/jsx";
import {
  buttonVariants,
  type ButtonVariantProps,
} from "@answerable/ui/lib/button";
import { cn } from "@answerable/ui/lib/utils";

export function Button({
  variant,
  size,
  class: className,
  ...props
}: JSX.IntrinsicElements["button"] & ButtonVariantProps) {
  return (
    <button
      {...props}
      class={cn(buttonVariants({ variant, size }), className)}
      data-slot="button"
    />
  );
}
