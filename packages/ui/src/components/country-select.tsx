"use client"

import { Combobox as ComboboxPrimitive } from "@base-ui/react/combobox"
import { countryGroups, findCountry, type Country } from "@answerable/countries"
import { Button } from "@answerable/ui/components/button"
import {
  Combobox,
  ComboboxCollection,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxInput,
  ComboboxItem,
  ComboboxLabel,
  ComboboxList,
  ComboboxSeparator,
  ComboboxTrigger,
  ComboboxValue,
} from "@answerable/ui/components/combobox"
import { Flag } from "@answerable/ui/components/flag"
import { cn } from "@answerable/ui/lib/utils"

const GROUPS = countryGroups().map((g) => ({ value: g.label, items: g.items }))

export type CountrySelectProps = {
  name?: string
  required?: boolean
  disabled?: boolean
  placeholder?: string
  defaultValue?: string | null
  value?: string | null
  onValueChange?: (code: string | null) => void
  id?: string
  className?: string
}

function CountrySelect({
  name,
  required,
  disabled,
  placeholder = "Select your country",
  defaultValue,
  value,
  onValueChange,
  id,
  className,
}: CountrySelectProps) {
  const { contains } = ComboboxPrimitive.useFilter({ sensitivity: "base" })

  return (
    <Combobox
      items={GROUPS}
      name={name}
      required={required}
      disabled={disabled}
      itemToStringValue={(c: Country) => c.code}
      itemToStringLabel={(c: Country) => c.name}
      isItemEqualToValue={(a: Country, b: Country) => a.code === b.code}
      filter={contains}
      autoHighlight
      {...(value !== undefined
        ? { value: findCountry(value ?? "") ?? null }
        : { defaultValue: findCountry(defaultValue ?? "") ?? null })}
      onValueChange={(c: Country | null) => onValueChange?.(c?.code ?? null)}
    >
      <ComboboxTrigger
        id={id}
        render={
          <Button
            variant="outline"
            className={cn(
              "w-full justify-between text-base font-normal md:text-sm",
              className,
            )}
          />
        }
      >
        <ComboboxValue>
          {(c: Country | null) =>
            c ? (
              <span className="flex min-w-0 items-center gap-2">
                <Flag code={c.code} />
                <span className="truncate">{c.name}</span>
              </span>
            ) : (
              <span className="text-muted-foreground">{placeholder}</span>
            )
          }
        </ComboboxValue>
      </ComboboxTrigger>
      <ComboboxContent>
        <ComboboxInput
          showTrigger={false}
          placeholder="Search countries"
          autoComplete="off"
        />
        <ComboboxEmpty>No countries found.</ComboboxEmpty>
        <ComboboxList>
          {(group: (typeof GROUPS)[number], index: number) => (
            <ComboboxGroup key={group.value} items={group.items}>
              <ComboboxLabel>{group.value}</ComboboxLabel>
              <ComboboxCollection>
                {(c: Country) => (
                  <ComboboxItem key={c.code} value={c}>
                    <Flag code={c.code} />
                    <span className="truncate">{c.name}</span>
                  </ComboboxItem>
                )}
              </ComboboxCollection>
              {index < GROUPS.length - 1 && <ComboboxSeparator />}
            </ComboboxGroup>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  )
}

export { CountrySelect }
