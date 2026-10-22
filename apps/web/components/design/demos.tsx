"use client"

import { ChevronDownIcon, InfoIcon } from "lucide-react"
import { Button } from "@answerable/ui/components/button"
import { Checkbox } from "@answerable/ui/components/checkbox"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@answerable/ui/components/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@answerable/ui/components/dropdown-menu"
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@answerable/ui/components/field"
import { Input } from "@answerable/ui/components/input"
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@answerable/ui/components/popover"
import {
  RadioGroup,
  RadioGroupItem,
} from "@answerable/ui/components/radio-group"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@answerable/ui/components/select"
import { Switch } from "@answerable/ui/components/switch"
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@answerable/ui/components/tabs"
import { Textarea } from "@answerable/ui/components/textarea"
import { Toaster, toast } from "@answerable/ui/components/toast"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@answerable/ui/components/tooltip"

import { BENEFITS, PROGRAMME, SECTIONS, VALUES } from "./content"

const VALUE_ITEMS = VALUES.map((value, index) => ({
  value: String(index + 1),
  label: value,
}))

/** The form controls: input, the error marker, textarea, select, checkbox, radio and switch. */
export function FormDemo() {
  return (
    <div className="grid gap-6 md:grid-cols-2">
      <Field>
        <FieldLabel>Email</FieldLabel>
        <Input type="email" placeholder="you@practice.com" />
        <FieldDescription>{PROGRAMME.enrol}</FieldDescription>
      </Field>
      {/* Invalid: the square marker beside the label, the message as black helper text. */}
      <Field invalid>
        <FieldLabel>Email</FieldLabel>
        <Input defaultValue="you@practice" aria-invalid />
        <FieldError match>{PROGRAMME.invalidEmail}</FieldError>
      </Field>
      <Field>
        <FieldLabel>What does good look like in your practice?</FieldLabel>
        <Textarea defaultValue={PROGRAMME.leadership} />
      </Field>
      <Field>
        <FieldLabel nativeLabel={false}>
          The value you would start with
        </FieldLabel>
        <Select items={VALUE_ITEMS} defaultValue="1">
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {VALUE_ITEMS.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <div className="flex flex-col gap-4">
        <label className="type-ui-text flex items-start gap-3">
          <Checkbox defaultChecked className="mt-0.5" />
          {PROGRAMME.notReserved}
        </label>
        <label className="type-ui-text flex items-center gap-3">
          <Switch defaultChecked />
          Email me when enrolment opens
        </label>
      </div>
      <RadioGroup defaultValue="lead" aria-label="Your role">
        <label className="type-ui-text flex items-center gap-3">
          <RadioGroupItem value="lead" />I am stepping into the AI Lead role
        </label>
        <label className="type-ui-text flex items-center gap-3">
          <RadioGroupItem value="colleague" />I am supporting a colleague who is
        </label>
      </RadioGroup>
    </div>
  )
}

/** The floating surfaces: dialog, dropdown menu, popover and tooltip. */
export function SurfaceDemo() {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Dialog>
        <DialogTrigger render={<Button />}>{PROGRAMME.join}</DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{PROGRAMME.join}</DialogTitle>
            <DialogDescription>{PROGRAMME.cohort}</DialogDescription>
          </DialogHeader>
          <p className="type-body-sm">{PROGRAMME.enrol}</p>
          <DialogFooter>
            <DialogClose render={<Button variant="secondary" />}>
              Not now
            </DialogClose>
            <DialogClose render={<Button />}>{PROGRAMME.register}</DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="secondary" />}>
          Programme
          <ChevronDownIcon />
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-72">
          <DropdownMenuGroup>
            <DropdownMenuLabel>Programme</DropdownMenuLabel>
            {SECTIONS.slice(0, 3).map((section) => (
              <DropdownMenuItem key={section}>{section}</DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem>{PROGRAMME.join}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Popover>
        <PopoverTrigger render={<Button variant="ghost" />}>
          The people behind the programme
        </PopoverTrigger>
        <PopoverContent className="w-96 max-w-[calc(100vw-2rem)]">
          <PopoverHeader>
            <PopoverTitle>Keir Regan-Alexander</PopoverTitle>
            <PopoverDescription>{PROGRAMME.people}</PopoverDescription>
          </PopoverHeader>
        </PopoverContent>
      </Popover>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon"
              aria-label="About registering"
            />
          }
        >
          <InfoIcon />
        </TooltipTrigger>
        <TooltipContent>{PROGRAMME.notReserved}</TooltipContent>
      </Tooltip>
    </div>
  )
}

/** Tabs over the programme's own sections. */
export function TabsDemo() {
  return (
    <Tabs defaultValue="role">
      <TabsList>
        <TabsTrigger value="role">The role</TabsTrigger>
        <TabsTrigger value="values">Values</TabsTrigger>
        <TabsTrigger value="cohort">Cohort</TabsTrigger>
      </TabsList>
      <TabsContent value="role" className="max-w-(--prose-max) pt-2">
        {PROGRAMME.role[0]}
      </TabsContent>
      <TabsContent value="values" className="max-w-(--prose-max) pt-2">
        {VALUES[0]} {VALUES[1]}
      </TabsContent>
      <TabsContent value="cohort" className="max-w-(--prose-max) pt-2">
        {BENEFITS[3]!.body}
      </TabsContent>
    </Tabs>
  )
}

/** A button that raises the dark toast. */
export function ToastDemo() {
  return (
    <Toaster>
      <Button
        variant="secondary"
        className="justify-self-start"
        onClick={() =>
          toast.add({
            title: "Registered",
            description: PROGRAMME.registered,
            type: "success",
          })
        }
      >
        Show a toast
      </Button>
    </Toaster>
  )
}
