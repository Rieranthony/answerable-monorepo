import { expect, test } from "bun:test"
import { refusalOf, testDatabase } from "./testing"

test("a test database refuses a URL that names any other database before it is reset, migrated, connected to or built beside", async () => {
  const named = (url?: string) => testDatabase("answerable_example_test", url)
  expect(named().url).toBe("postgres://answerable:answerable@localhost:47432/answerable_example_test")
  expect(() => named("postgres://u:p@localhost:47436/answerable_example_test").assertDisposable("reset")).not.toThrow()
  expect(() => named("postgres://u:p@localhost:47432/answerable_admin").assertDisposable("migrate")).toThrow("Refusing to migrate answerable_admin; expected answerable_example_test")
  expect(() => named("postgres://u:p@localhost:47432/answerable_toolbox_test").connect()).toThrow("Refusing to connect to answerable_toolbox_test; expected answerable_example_test")
  expect(() => named("postgres://u:p@localhost:47432").assertDisposable("reset")).toThrow("Refusing to reset an unnamed database; expected answerable_example_test")
  await expect(named("postgres://u:p@localhost:47432/answerable_toolbox").runtimeLogin([])).rejects.toThrow("Refusing to provision a login on answerable_toolbox; expected answerable_example_test")
  await expect(named("postgres://u:p@localhost:47432/answerable_toolbox").scratch("legacy")).rejects.toThrow("Refusing to create a scratch database beside answerable_toolbox; expected answerable_example_test")
})

test("refusalOf gives the database's message from drizzle's query error, any other error's message, and refuses a query that succeeded", async () => {
  expect(await refusalOf(Promise.reject(new Error("plain")))).toBe("plain")
  await expect(refusalOf(Promise.resolve(1))).rejects.toThrow("The query succeeded")
})
