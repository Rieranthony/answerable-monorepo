import { expect, test } from "bun:test";

// ID sends mail, and bundles the precompiled strings and the transport: never a renderer.
// `bun run build` runs this same `bun build`, so a CI image cannot differ.
test("the service's bundle holds the mail and no React", async () => {
  const built = await Bun.build({
    entrypoints: [new URL("./server.ts", import.meta.url).pathname],
    target: "bun",
  });
  expect(built.success).toBe(true);
  const bundle = await built.outputs[0]!.text();
  expect(bundle).toContain("api.postmarkapp.com");
  expect(bundle).toContain("Sign in to {{firmName}}");
  for (const marker of [
    "react.transitional.element",
    "react-dom",
    "@react-email",
    "renderToStaticMarkup",
    "html-to-text",
    "prettier",
  ])
    expect(bundle, marker).not.toContain(marker);
});
