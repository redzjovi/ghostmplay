<script lang="ts" setup>
import type { CalendarHeaderProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { reactiveOmit } from "@vueuse/core"
import { CalendarHeader, useForwardProps } from "reka-ui"
import { cn } from "@/lib/utils"
import CalendarNextButton from "./CalendarNextButton.vue"
import CalendarPrevButton from "./CalendarPrevButton.vue"
import CalendarMonthYearSelects from "./CalendarMonthYearSelects.vue"

const props = defineProps<CalendarHeaderProps & { class?: HTMLAttributes["class"] }>()

const delegatedProps = reactiveOmit(props, "class")

const forwardedProps = useForwardProps(delegatedProps)
</script>

<template>
  <CalendarHeader
    :class="cn('relative flex w-full items-center justify-between pt-1', props.class)"
    v-bind="forwardedProps"
  >
    <slot>
      <CalendarPrevButton />
      <CalendarMonthYearSelects />
      <CalendarNextButton />
    </slot>
  </CalendarHeader>
</template>
