import { expect, test } from "bun:test"
import { assertDisposable } from "./database"

test("only the disposable test database may be reset or migrated", () => {
  expect(() => assertDisposable("reset", "postgres://u:p@localhost:47432/answerable_mcp_postgres_test")).not.toThrow()
  expect(() => assertDisposable("reset", "postgres://u:p@localhost:47432/answerable_toolbox_test")).toThrow("Refusing to reset answerable_toolbox_test; expected answerable_mcp_postgres_test")
  expect(() => assertDisposable("migrate", "postgres://u:p@localhost:47432/answerable_admin")).toThrow("Refusing to migrate answerable_admin; expected answerable_mcp_postgres_test")
  expect(() => assertDisposable("reset", "postgres://u:p@localhost:47432")).toThrow("Refusing to reset an unnamed database; expected answerable_mcp_postgres_test")
})
