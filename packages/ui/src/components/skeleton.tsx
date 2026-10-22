import { cn } from "@answerable/ui/lib/utils"

/** The muted fill with a gentle 1.5s pulse; still when the reader prefers less motion. */
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn(
        "animate-pulse rounded-lg bg-muted [animation-duration:1.5s] motion-reduce:animate-none",
        className,
      )}
      {...props}
    />
  )
}

export { Skeleton }
