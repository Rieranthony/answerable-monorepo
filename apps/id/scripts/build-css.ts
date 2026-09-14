import path from "node:path";
import { buildCss } from "hono-tailwind";

const out = path.join(import.meta.dir, "../dist/tailwind.css");
await buildCss({
  in: path.join(import.meta.dir, "../src/http/pages/styles.css"),
  out,
  minify: true,
});
console.log(`Built tailwind.css (${Bun.file(out).size} bytes)`);
