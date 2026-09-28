<script lang="ts" setup>
import { ref, watch } from "vue"
import { injectCalendarRootContext } from "reka-ui"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December"
]

const YEAR_RANGE = 10
const thisYear = new Date().getFullYear()
const YEARS = Array.from({ length: YEAR_RANGE * 2 + 1 }, (_, i) => String(thisYear - YEAR_RANGE + i))

// Placeholder ref comes from reka-ui's own types: all date objects stay in
// <script setup> (plain assignments) and only strings cross the template.
const { placeholder } = injectCalendarRootContext()

const month = ref(String(placeholder.value.month))
const year = ref(String(placeholder.value.year))

// Stay in sync when the month arrows are used.
watch(
  () => [placeholder.value.year, placeholder.value.month],
  ([y, m]) => {
    year.value = String(y)
    month.value = String(m)
  }
)

function apply() {
  const y = Number(year.value)
  const m = Number(month.value)
  if (!Number.isInteger(y) || !Number.isInteger(m) || m < 1 || m > 12) return
  const current = placeholder.value
  if (current.year === y && current.month === m) return
  placeholder.value = current.set({ year: y, month: m })
}
</script>

<template>
  <div class="flex items-center gap-1">
    <Select :model-value="month" @update:model-value="(v) => { month = String(v); apply() }">
      <SelectTrigger class="h-7 w-[110px] text-xs" aria-label="Select month">
        <SelectValue placeholder="Month" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem v-for="(label, i) in MONTHS" :key="label" :value="String(i + 1)">{{ label }}</SelectItem>
      </SelectContent>
    </Select>
    <Select :model-value="year" @update:model-value="(v) => { year = String(v); apply() }">
      <SelectTrigger class="h-7 w-[76px] text-xs" aria-label="Select year">
        <SelectValue placeholder="Year" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem v-for="y in YEARS" :key="y" :value="y">{{ y }}</SelectItem>
      </SelectContent>
    </Select>
  </div>
</template>
