// Source: hampusborgos/country-flags at one commit, FLAG_COMMIT below. countries.json is that commit's file and the flag
// images load from the same commit, so neither drifts when upstream pushes. Refresh both together: choose a commit,
// re-download countries.json from https://cdn.jsdelivr.net/gh/hampusborgos/country-flags@<commit>/countries.json,
// change FLAG_COMMIT and the URL in index.test.ts, and check that svg/ holds a file for every code.
import data from "./countries.json"

const FLAG_COMMIT = "c09927e63705529bbf59ca6684cd9b23225dddad"

export type Country = { code: string; name: string }

export const COUNTRIES: readonly Country[] = Object.entries(data)
  .filter(([code]) => code !== "EU" && !code.startsWith("GB-"))
  .map(([code, name]) => ({ code, name }))
  .sort((a, b) => a.name.localeCompare(b.name, "en"))

export const EU_COUNTRY_CODES: readonly string[] = [
  "AT",
  "BE",
  "BG",
  "HR",
  "CY",
  "CZ",
  "DK",
  "EE",
  "FI",
  "FR",
  "DE",
  "GR",
  "HU",
  "IE",
  "IT",
  "LV",
  "LT",
  "LU",
  "MT",
  "NL",
  "PL",
  "PT",
  "RO",
  "SK",
  "SI",
  "ES",
  "SE",
]

export const PRIORITY_COUNTRY_CODES: readonly string[] = [
  "GB",
  "US",
  ...COUNTRIES.filter((country) => EU_COUNTRY_CODES.includes(country.code)).map(
    (country) => country.code,
  ),
]

export function findCountry(code: string): Country | undefined {
  const normalised = code.trim().toUpperCase()
  return COUNTRIES.find((country) => country.code === normalised)
}

export function flagUrl(code: string): string {
  return `https://cdn.jsdelivr.net/gh/hampusborgos/country-flags@${FLAG_COMMIT}/svg/${code.trim().toLowerCase()}.svg`
}

export type CountryGroup = { label: string; items: readonly Country[] }

export function countryGroups(): readonly CountryGroup[] {
  return [
    {
      label: "Suggested",
      items: PRIORITY_COUNTRY_CODES.map((code) => findCountry(code)!),
    },
    {
      label: "All countries",
      items: COUNTRIES.filter(
        (country) => !PRIORITY_COUNTRY_CODES.includes(country.code),
      ),
    },
  ]
}
