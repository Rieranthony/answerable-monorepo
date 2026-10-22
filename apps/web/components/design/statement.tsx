import {
  HighlightPanel,
  HighlightPanelBody,
  HighlightPanelTitle,
} from "@answerable/ui/components/statement/highlight-panel"
import {
  NumberedStep,
  NumberedStepBody,
  NumberedSteps,
  NumberedStepTitle,
} from "@answerable/ui/components/statement/numbered-steps"
import {
  QuotePanel,
  QuotePanelAttribution,
  QuotePanelQuote,
} from "@answerable/ui/components/statement/quote-panel"
import {
  Stat,
  StatLabel,
  StatValue,
} from "@answerable/ui/components/statement/stat"
import {
  StatDisplay,
  StatDisplayLabel,
  StatDisplayValue,
} from "@answerable/ui/components/statement/stat-display"
import { StatementDivider } from "@answerable/ui/components/statement/statement-divider"

import { BENEFITS, PROGRAMME, VALUES } from "./content"
import type { Accent } from "./lib"
import { ShowcaseGroup } from "./section"

const STATS = [
  ["6", "core values behind everything the programme teaches"],
  ["100+", "AEC firms helped to develop their approach to AI"],
  ["3", "years of that work behind the programme"],
  ["4", "things the founding cohort gets"],
] as const

/** The statement layer: the pieces a presentation or report uses to make a point. */
export function StatementComponents({ accent }: { accent: Accent }) {
  return (
    <div className="flex flex-col gap-12">
      <ShowcaseGroup
        title="Stat row"
        caption="One to four metrics; one shared accent or none."
      >
        <div className="grid grid-cols-2 gap-8 md:grid-cols-4">
          {STATS.map(([value, label]) => (
            <Stat key={label}>
              <StatValue highlight={accent}>{value}</StatValue>
              <StatLabel>{label}</StatLabel>
            </Stat>
          ))}
        </div>
      </ShowcaseGroup>

      <ShowcaseGroup
        title="Stat display"
        caption="For reports and milestone moments."
      >
        <StatDisplay>
          <StatDisplayValue>100+</StatDisplayValue>
          <StatDisplayLabel>
            {PROGRAMME.people.split(". ")[0]}.
          </StatDisplayLabel>
        </StatDisplay>
      </ShowcaseGroup>

      <ShowcaseGroup
        title="Quote panels"
        caption="Black with white, or white with black; never accent-coloured, never bordered."
      >
        <div className="grid gap-6 lg:grid-cols-2">
          <QuotePanel tone="black">
            <QuotePanelQuote>{VALUES[0]}</QuotePanelQuote>
            <QuotePanelAttribution>
              The first of six core values
            </QuotePanelAttribution>
          </QuotePanel>
          <QuotePanel tone="white">
            <QuotePanelQuote>{VALUES[5]}</QuotePanelQuote>
            <QuotePanelAttribution>The sixth core value</QuotePanelAttribution>
          </QuotePanel>
        </div>
      </ShowcaseGroup>

      <ShowcaseGroup
        title="Highlight panel"
        caption="For a key message, milestone or call to commitment."
      >
        <HighlightPanel>
          <HighlightPanelTitle level={3}>{PROGRAMME.join}</HighlightPanelTitle>
          <HighlightPanelBody>
            {PROGRAMME.cohort} {PROGRAMME.enrol}
          </HighlightPanelBody>
        </HighlightPanel>
      </ShowcaseGroup>

      <ShowcaseGroup
        title="Numbered steps"
        caption="32px Black numerals, one marker per item, all the same size."
      >
        <NumberedSteps>
          {BENEFITS.map(({ lead, body }) => (
            <NumberedStep key={lead}>
              <NumberedStepTitle level={4}>{lead}</NumberedStepTitle>
              <NumberedStepBody>{body}</NumberedStepBody>
            </NumberedStep>
          ))}
        </NumberedSteps>
      </ShowcaseGroup>

      <ShowcaseGroup
        title="Statement divider"
        caption="3px black, for major editorial breaks."
      >
        <StatementDivider />
      </ShowcaseGroup>
    </div>
  )
}
