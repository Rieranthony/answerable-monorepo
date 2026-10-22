import { cva, type VariantProps } from "class-variance-authority"

/*
 * Square, filled, no outline. Hover and pressed fills mix the fill toward its
 * own text colour, so they follow any injected design; accent and destructive
 * fills fade instead.
 */
export const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center gap-2 rounded-lg type-button whitespace-nowrap transition-[color,background-color,opacity] duration-fast outline-none select-none focus-visible:focus-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground hover:bg-[color-mix(in_oklab,var(--primary),var(--primary-foreground)_27%)] active:bg-[color-mix(in_oklab,var(--primary),var(--primary-foreground)_21%)]",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-[color-mix(in_oklab,var(--secondary),var(--secondary-foreground)_6%)] active:bg-[color-mix(in_oklab,var(--secondary),var(--secondary-foreground)_12%)] aria-expanded:bg-[color-mix(in_oklab,var(--secondary),var(--secondary-foreground)_6%)]",
        ghost:
          "hover:bg-accent hover:text-accent-foreground active:bg-[color-mix(in_oklab,var(--accent),var(--accent-foreground)_6%)] aria-expanded:bg-accent aria-expanded:text-accent-foreground",
        link: "text-foreground decoration-2 underline-offset-4 hover:underline",
        destructive:
          "bg-destructive text-destructive-foreground hover:opacity-90 active:opacity-80",
        accent: "text-on-accent hover:opacity-90 active:opacity-80",
      },
      size: {
        sm: "h-(--control-sm) px-3",
        default: "h-(--control-md) px-4",
        lg: "h-(--control-lg) px-5",
        xl: "h-(--control-xl) px-6",
        icon: "size-(--control-md)",
        "icon-sm": "size-(--control-sm)",
        "icon-lg": "size-(--control-lg)",
      },
      /** The accent fill, in rotation order (Sky, Yellow, Green, Coral by default). Only the `accent` variant reads it. */
      highlight: { 1: "", 2: "", 3: "", 4: "" },
    },
    compoundVariants: [
      { variant: "link", className: "h-auto px-0" },
      { variant: "accent", highlight: 1, className: "bg-highlight-1" },
      { variant: "accent", highlight: 2, className: "bg-highlight-2" },
      { variant: "accent", highlight: 3, className: "bg-highlight-3" },
      { variant: "accent", highlight: 4, className: "bg-highlight-4" },
    ],
    defaultVariants: {
      variant: "default",
      size: "default",
      highlight: 1,
    },
  },
)

export type ButtonVariantProps = VariantProps<typeof buttonVariants>
