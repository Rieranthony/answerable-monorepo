/*
 * The filled text control: a neutral fill with no border that deepens on hover
 * and turns to the page colour, with the focus ring, on focus. An invalid
 * field is marked beside its label (`FieldLabel`), never on the control.
 * Below `md` the text is body-md (16px), so iOS does not zoom on focus.
 * ID's sign-in pages read this string directly.
 */
export const inputClassName =
  "h-(--control-md) w-full min-w-0 rounded-lg bg-input px-3 type-ui-text text-foreground transition-colors duration-fast outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:type-label file:text-foreground placeholder:text-muted-foreground hover:bg-[color-mix(in_oklab,var(--input),var(--foreground)_6%)] focus-visible:bg-background focus-visible:focus-ring disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 max-md:type-body-md"

/** The same fill on a button that opens a list: the select trigger and the country picker. */
export const selectTriggerClassName =
  "flex h-(--control-md) w-fit items-center justify-between gap-2 rounded-lg bg-input px-3 text-left type-ui-text whitespace-nowrap text-foreground transition-colors duration-fast outline-none select-none hover:bg-[color-mix(in_oklab,var(--input),var(--foreground)_6%)] focus-visible:bg-background focus-visible:focus-ring disabled:cursor-not-allowed disabled:opacity-50 data-placeholder:text-muted-foreground data-popup-open:bg-[color-mix(in_oklab,var(--input),var(--foreground)_6%)] [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"
