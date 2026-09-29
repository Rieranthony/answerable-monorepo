import { expect, spyOn, test } from "bun:test"
import { cleanup, onCleanup } from "./cleanup"

test("closers run last registered first, and a closer that throws does not stop the rest", async () => {
  const order: string[] = []
  onCleanup(() => order.push("first"))
  onCleanup(() => {
    throw new Error("does not matter")
  })
  onCleanup(async () => {
    await Bun.sleep(10)
    order.push("last")
  })
  await cleanup()
  expect(order).toEqual(["last", "first"])
})

test("a second call waits for the first and runs nothing twice", async () => {
  let finished = false
  let runs = 0
  onCleanup(async () => {
    runs++
    await Bun.sleep(20)
    finished = true
  })
  const first = cleanup()
  await cleanup()
  expect(finished).toBe(true)
  await first
  expect(runs).toBe(1)
})

test.each([
  ["SIGINT", 130],
  ["SIGTERM", 143],
] as const)("%s runs the closers and then exits with %d", async (signal, code) => {
  const closed: string[] = []
  onCleanup(() => closed.push(signal))
  const exit = spyOn(process, "exit")
  const exited = new Promise<number>(resolve => exit.mockImplementation(((status: number) => resolve(status)) as never))
  process.emit(signal)
  expect(await exited).toBe(code)
  expect(closed).toEqual([signal])
  exit.mockRestore()
})
