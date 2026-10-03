import { expect, test } from "bun:test"
import { testDatabase } from "./testing"

test("a test database refuses a URL that names any other database before it is reset, migrated or connected to", () => {
  const named = (url?: string) => testDatabase("answerable_example_test", url)
  expect(named().url).toBe("postgres://answerable:answerable@localhost:47432/answerable_example_test")
  expect(() => named("postgres://u:p@localhost:47436/answerable_example_test").assertDisposable("reset")).not.toThrow()
  expect(() => named("postgres://u:p@localhost:47432/answerable_admin").assertDisposable("migrate")).toThrow("Refusing to migrate answerable_admin; expected answerable_example_test")
  expect(() => named("postgres://u:p@localhost:47432/answerable_toolbox_test").connect()).toThrow("Refusing to connect to answerable_toolbox_test; expected answerable_example_test")
  expect(() => named("postgres://u:p@localhost:47432").assertDisposable("reset")).toThrow("Refusing to reset an unnamed database; expected answerable_example_test")
})
