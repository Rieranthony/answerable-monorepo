// Source: https://cdn.jsdelivr.net/gh/hampusborgos/country-flags@main/countries.json
// Refresh by re-downloading countries.json from that URL.
import data from "./countries.json"

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
  return `https://cdn.jsdelivr.net/gh/hampusborgos/country-flags@main/svg/${code.trim().toLowerCase()}.svg`
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
