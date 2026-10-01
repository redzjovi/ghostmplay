<script setup lang="ts">
import { computed } from 'vue'
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationNext,
  PaginationPrevious,
} from '@/components/ui/pagination'
import { totalPageCount } from '@/lib/listQuery'

/**
 * Page controls for the list views. Wraps the ui/pagination primitives (reka-ui)
 * so the ellipsis window is derived once here instead of being hand-rolled per
 * view. Fully controlled: the parent decides what a page change means, which is
 * how both views turn a click into a router push.
 */
const props = withDefaults(
  defineProps<{
    page: number
    limit: number
    total: number
    siblingCount?: number
  }>(),
  { siblingCount: 1 },
)

const emit = defineEmits<{ 'update:page': [page: number] }>()

const totalPages = computed(() => totalPageCount(props.total, props.limit))
</script>

<template>
  <Pagination
    v-if="totalPages > 1"
    :page="page"
    :items-per-page="limit"
    :total="total"
    :sibling-count="siblingCount"
    show-edges
    @update:page="emit('update:page', $event)"
  >
    <PaginationContent v-slot="{ items }">
      <PaginationPrevious>‹ Prev</PaginationPrevious>
      <template v-for="(item, index) in items" :key="index">
        <PaginationItem v-if="item.type === 'page'" :value="item.value" :is-active="item.value === page" size="sm">
          {{ item.value }}
        </PaginationItem>
        <PaginationEllipsis v-else />
      </template>
      <PaginationNext>Next ›</PaginationNext>
    </PaginationContent>
  </Pagination>
</template>
