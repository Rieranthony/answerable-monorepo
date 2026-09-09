import { describe, expect, test } from "bun:test"
import {
  COUNTRIES,
  EU_COUNTRY_CODES,
  PRIORITY_COUNTRY_CODES,
  countryGroups,
  findCountry,
  flagUrl,
} from "./index"

describe("countries", () => {
  test("contains 250 unique alpha-2 countries and excludes regional entries", () => {
    expect(COUNTRIES).toHaveLength(250)
    expect(new Set(COUNTRIES.map((country) => country.code)).size).toBe(250)
    for (const country of COUNTRIES) expect(country.code).toMatch(/^[A-Z]{2}$/)
    for (const code of ["EU", "GB-ENG", "GB-NIR", "GB-SCT", "GB-WLS"])
      expect(findCountry(code)).toBeUndefined()
  })
  test("has the expected names and English name order", () => {
    for (const [code, name] of Object.entries({
      GB: "United Kingdom",
      US: "United States",
      FR: "France",
      XK: "Kosovo",
    }))
      expect(findCountry(code)).toEqual({ code, name })
    expect(COUNTRIES).toEqual(
      [...COUNTRIES].sort((a, b) => a.name.localeCompare(b.name, "en")),
    )
  })
  test("suggests GB, US and all 27 EU members in name order", () => {
    const eu =
      "AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE".split(
        " ",
      )
    expect(EU_COUNTRY_CODES).toHaveLength(27)
    expect([...EU_COUNTRY_CODES].sort()).toEqual([...eu].sort())
    for (const code of eu) expect(findCountry(code)).toBeDefined()
    expect(PRIORITY_COUNTRY_CODES).toHaveLength(29)
    expect(PRIORITY_COUNTRY_CODES.slice(0, 4)).toEqual(["GB", "US", "AT", "BE"])
    expect(PRIORITY_COUNTRY_CODES).toEqual([
      "GB",
      "US",
      ...COUNTRIES.filter((country) => eu.includes(country.code)).map(
        (country) => country.code,
      ),
    ])
  })
  test("groups every country exactly once in the expected order", () => {
    const groups = countryGroups()
    expect(groups.map((group) => group.label)).toEqual([
      "Suggested",
      "All countries",
    ])
    expect(groups[0].items.map((country) => country.code)).toEqual([
      ...PRIORITY_COUNTRY_CODES,
    ])
    expect(groups[1].items).toEqual(
      COUNTRIES.filter(
        (country) => !PRIORITY_COUNTRY_CODES.includes(country.code),
      ),
    )
    const codes = groups.flatMap((group) =>
      group.items.map((country) => country.code),
    )
    expect(codes).toHaveLength(250)
    expect(new Set(codes).size).toBe(250)
  })
  test("normalises lookup and flag codes", () => {
    expect(findCountry(" gb ")).toBe(findCountry("GB"))
    expect(findCountry("zz")).toBeUndefined()
    expect(findCountry("")).toBeUndefined()
    expect(flagUrl("GB")).toBe(
      "https://cdn.jsdelivr.net/gh/hampusborgos/country-flags@main/svg/gb.svg",
    )
    expect(flagUrl(" gb ")).toBe(flagUrl("GB"))
  })
})
