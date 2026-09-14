import { LOGO_PATHS, LOGO_VIEW_BOX } from "@answerable/ui/lib/logo";

const FRAME = LOGO_PATHS.filter((path) => path.group === "frame");
const WORDMARK = LOGO_PATHS.filter((path) => path.group === "wordmark");
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
      <g data-logo-group="frame">
        {FRAME.map((path) => (
          <path data-logo-part={path.id} d={path.d} />
        ))}
      </g>
      <g data-logo-group="wordmark">
        {WORDMARK.map((path) => (
          <path data-logo-part={path.id} d={path.d} />
        ))}
      </g>
    </svg>
  );
}
