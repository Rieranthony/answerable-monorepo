// Keep Bun 1.3.1's runtime module cache separate from its browser bundler cache.
export {}
const result = await Bun.build({
  entrypoints: [process.argv[2]], target: "browser", minify: true,
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
})
if (!result.success) {
  console.error(result.logs.map(log => log.message).join("; "))
  process.exit(1)
}
console.log(JSON.stringify(await Promise.all(result.outputs.map(async output => ({ path: output.path, text: await output.text() })))))
