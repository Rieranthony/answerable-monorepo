import { LOGO_PATHS, LOGO_VIEW_BOX } from "@answerable/ui/lib/logo";

export function Logo(props: { class?: string }) {
  return (
    <svg
      viewBox={LOGO_VIEW_BOX}
      fill="currentColor"
      role="img"
      aria-label="Answerable"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      {LOGO_PATHS.map((path) => (
        <path d={path.d} />
      ))}
    </svg>
  );
}
