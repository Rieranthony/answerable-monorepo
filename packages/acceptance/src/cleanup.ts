const closers: Array<() => unknown> = []
let running: Promise<void> = Promise.resolve()

/** Run `close` when the kit stops, before anything registered earlier. */
export function onCleanup(close: () => unknown) {
  closers.push(close)
}

/** Run every registered closer, last registered first. A closer that throws does not stop the rest, and a second call waits for the first. */
export function cleanup() {
  const batch = closers.splice(0).reverse()
  running = running.then(async () => {
    for (const close of batch) {
      try {
        await close()
      } catch {
        // Keep releasing what remains.
      }
    }
  })
  return running
}

// Ctrl-C and SIGTERM stop everything the kit opened, then exit as a signal would.
for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
  process.on(signal, () => void cleanup().finally(() => process.exit(code)))
}
