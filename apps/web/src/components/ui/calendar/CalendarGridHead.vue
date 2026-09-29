<script lang="ts" setup>
import type { CalendarGridHeadProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { reactiveOmit } from "@vueuse/core"
import { CalendarGridHead, useForwardProps } from "reka-ui"
import { cn } from "@/lib/utils"

const props = defineProps<CalendarGridHeadProps & { class?: HTMLAttributes["class"] }>()

const delegatedProps = reactiveOmit(props, "class")
const forwardedProps = useForwardProps(delegatedProps)
</script>

<template>
  <CalendarGridHead v-bind="forwardedProps" :class="cn(props.class)">
    <slot />
  </CalendarGridHead>
</template>
