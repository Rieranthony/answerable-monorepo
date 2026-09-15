import type { BrandMark } from "@answerable/ui/lib/directory-logos";
export function DirectoryLogo({
  mark,
  class: className,
}: {
  mark: BrandMark;
  class?: string;
}) {
  return (
    <svg
      viewBox={mark.viewBox}
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      class={className}
    >
      {mark.paths.map((path) => (
        <path fill={path.fill} d={path.d} />
      ))}
    </svg>
  );
}
