// Compiles the sign-in pages' stylesheet into the file the pages serve, next to
// the module that serves it: src/http/pages/tailwind.css for a source run (the
// default; `dev` and the test preload run it), dist/tailwind.css for the bundle
// (`build` passes it). The service never compiles it.
import path from "node:path";
import { buildCss } from "hono-tailwind";

const out = path.resolve(
  process.argv[2] ??
    path.join(import.meta.dir, "../src/http/pages/tailwind.css"),
);
await buildCss({
  in: path.join(import.meta.dir, "../src/http/pages/styles.css"),
  out,
  minify: true,
});
console.log(
  `Built ${path.relative(process.cwd(), out)} (${Bun.file(out).size} bytes)`,
);
