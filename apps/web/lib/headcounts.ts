/** The founding cohort form's headcount bands, as the sheet stores them. */
export const HEADCOUNTS = ["1–10", "11–50", "51–200", "201+"]

export function isHeadcount(value: string): boolean {
  return HEADCOUNTS.includes(value)
}
