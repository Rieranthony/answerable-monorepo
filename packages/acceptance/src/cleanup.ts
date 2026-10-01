const closers: Array<() => unknown> = []
let running: Promise<void> = Promise.resolve()

/** Run `close` when the kit stops, before anything registered earlier. */
export function onCleanup(close: () => unknown) {
  closers.push(close)
}

/**
 * Run every registered closer, last registered first, then collect garbage. A closer that throws does not stop the rest, and a second call waits for the first.
 * The collection is not tidiness. Without it, after the admin journeys, the next file's Chromium exited with status 0 a few seconds after launch
 * ("Connection terminated while reading from pipe") and its sign-ins and `close` hung: 9 of 9 runs; with it, 7 of 7 passed. The cause is not
 * established; the likeliest is a finalizer of an earlier file closing a descriptor number that Chromium's pipe had reused.
 */
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
    Bun.gc(true)
  })
  return running
}

// Ctrl-C and SIGTERM stop everything the kit opened, then exit as a signal would.
for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
  process.on(signal, () => void cleanup().finally(() => process.exit(code)))
}
