<template>
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent class="max-w-[640px] sm:max-w-[620px] max-h-[85vh] overflow-y-auto p-0 gap-0">
      <DialogHeader class="p-6 pb-3">
        <DialogTitle class="flex flex-wrap items-center gap-2 text-base">
          <span class="truncate">{{ displayName }}</span>
          <Badge v-if="isSoldOut" variant="destructive" class="text-xs shrink-0">Sold Out</Badge>
        </DialogTitle>
        <DialogDescription class="text-xs font-mono">Token ID: {{ tokenId ?? '-' }}</DialogDescription>
      </DialogHeader>

      <div v-if="loading" class="p-6 space-y-4">
        <Skeleton class="h-[220px] w-full rounded-lg" />
        <Skeleton class="h-4 w-3/4" />
        <Skeleton class="h-20 w-full" />
      </div>

      <div v-else-if="!hasData" class="p-6">
        <Alert variant="destructive">
          <AlertTitle>Item not found</AlertTitle>
          <AlertDescription class="text-xs">Token #{{ tokenId }} not in local DB. Try Sync.</AlertDescription>
        </Alert>
      </div>

      <div v-else class="px-6 pb-6 space-y-4">
        <!-- Image + Basic Info -->
        <div class="grid grid-cols-1 sm:grid-cols-[240px_1fr] gap-4">
          <div class="relative overflow-hidden rounded-lg bg-muted">
            <AspectRatio :ratio="1" class="relative w-full bg-muted overflow-hidden">
              <Badge v-if="isSoldOut" variant="destructive" class="absolute top-2 left-2 z-10 text-[10px]">Sold Out</Badge>
              <Skeleton v-if="!imageUrl || imgError" class="absolute inset-0 h-full w-full" />
              <div v-if="!imageUrl || imgError" class="absolute inset-0 grid place-items-center bg-muted p-2 text-center">
                <ImageOff class="h-8 w-8 opacity-30 mx-auto" />
                <div class="text-xs mt-1 line-clamp-2">{{ displayName }}</div>
              </div>
              <img v-if="imageUrl && !imgError" :src="imageUrl" :alt="displayName" class="h-full w-full object-contain bg-white" :class="{ 'opacity-60': isSoldOut }" decoding="async" @error="imgError = true" />
            </AspectRatio>
          </div>
          <div class="space-y-3">
            <div class="space-y-2">
              <div class="flex flex-wrap items-center gap-2">
                <Badge variant="secondary" class="gap-1"><Shield class="h-3 w-3" />{{ equipmentType || '-' }}</Badge>
                <Badge variant="outline">Token #{{ tokenId }}</Badge>
                <Badge v-if="isLive" variant="secondary" class="text-[11px]" title="Fetched live from market API, not stored locally">Live</Badge>
              </div>
              <div class="text-sm">
                <div class="text-xs text-muted-foreground">Name</div>
                <div class="font-medium truncate" :title="displayName">{{ displayName }}</div>
              </div>
              <div class="text-sm">
                <div class="text-xs text-muted-foreground">Equipment Type</div>
                <div class="font-medium">{{ equipmentType || '-' }}</div>
              </div>
              <div class="text-sm">
                <div class="text-xs text-muted-foreground">Token ID</div>
                <div class="font-mono text-xs">{{ tokenId }}</div>
              </div>
            </div>
            <p v-if="isSoldOut" class="text-xs text-muted-foreground">No detail (empty) — sold out.</p>
          </div>
        </div>

        <!-- Attributes -->
        <Card v-if="attributes.length">
          <CardHeader class="pb-2">
            <CardTitle class="text-sm">Attributes</CardTitle>
          </CardHeader>
          <CardContent>
            <div class="grid grid-cols-2 gap-2">
              <div v-for="a in attributes" :key="a.type" class="flex justify-between items-center p-2 rounded bg-muted/50 border">
                <span class="text-xs text-muted-foreground">{{ a.type }}</span>
                <span class="text-xs font-semibold">{{ a.value }}</span>
              </div>
            </div>
          </CardContent>
        </Card>

        <!-- Basic Effect -->
        <Card v-if="basicSection">
          <CardHeader class="pb-2">
            <CardTitle class="text-sm flex items-center gap-2">
              <span class="h-2 w-2 rounded-full" :class="dotColor(basicSection.title)"></span>
              {{ basicSection.title }}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div class="grid grid-cols-2 gap-2">
              <div v-for="(e, idx) in basicEntries" :key="idx" class="flex justify-between items-center p-2 rounded bg-muted/40 border">
                <span class="text-xs font-medium" :style="styleFor(e.key)">{{ e.key }}</span>
                <span class="text-xs font-semibold">{{ e.value }}</span>
              </div>
            </div>
          </CardContent>
        </Card>

        <!-- Grade Effect -->
        <Card v-if="gradeSection">
          <CardHeader class="pb-2">
            <CardTitle class="text-sm flex items-center gap-2">
              <span class="h-2 w-2 rounded-full" :class="dotColor(gradeSection.title)"></span>
              {{ gradeSection.title }}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div class="grid grid-cols-2 gap-2">
              <div v-for="(e, idx) in gradeEntries" :key="idx" class="flex justify-between items-center p-2 rounded bg-muted/40 border">
                <span class="text-xs font-medium" :style="styleFor(e.key)">{{ e.key }}</span>
                <span class="text-xs font-semibold">{{ e.value }}</span>
              </div>
            </div>
          </CardContent>
        </Card>

        <div v-if="!attributes.length && !basicSection && !gradeSection && !isSoldOut" class="text-xs text-muted-foreground text-center py-4">No detail data for preview.</div>
      </div>

      <DialogFooter class="p-6 pt-2 flex gap-2">
        <Button variant="outline" @click="emit('update:open', false)">Close</Button>
        <Button @click="goFull">View Full Detail</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useRouter } from 'vue-router'
import { Shield, ImageOff } from 'lucide-vue-next'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert'
import { AspectRatio } from '@/components/ui/aspect-ratio'
import { normalizeImageUrl, styleFor, dotColor, isSimpleValues, simpleValues, parseDetail, adaptLiveDetail } from '@/lib/itemDetailHelpers'

const props = defineProps<{ tokenId: number | null; open: boolean; fallbackItem?: { name?: string; imageUrl?: string; equipmentType?: string } | null }>()
const emit = defineEmits<{ (e: 'update:open', v: boolean): void }>()
const router = useRouter()

const loading = ref(false)
const raw = ref<unknown>(null)
const imgError = ref(false)
const isLive = ref(false)
const cache = new Map<number, unknown>()
const liveIds = new Set<number>()

const hasData = computed(() => {
  const d = raw.value as { item?: unknown } | null
  if (d && (d as { item?: unknown }).item) return true
  const v = raw.value as Record<string, unknown> | null
  if (v && typeof v.tokenId === 'number') return true
  // fallbackItem allows header even if no detail
  return !!props.fallbackItem
})

const item = computed(() => {
  const d = raw.value as { item?: Record<string, unknown> } | null
  if (d?.item) return d.item as Record<string, unknown>
  const v = raw.value as Record<string, unknown> | null
  if (v && typeof v.tokenId === 'number') return v
  return null
})

const detail = computed(() => {
  const d = raw.value as { detail?: unknown } | null
  return (d?.detail as { attributes: unknown; datas: unknown } | null) ?? null
})

const displayName = computed(() => String(item.value?.name ?? props.fallbackItem?.name ?? `#${props.tokenId ?? ''}`))
const equipmentType = computed(() => String(item.value?.equipmentType ?? props.fallbackItem?.equipmentType ?? ''))
const imageUrl = computed(() => normalizeImageUrl(String(item.value?.imageUrl ?? props.fallbackItem?.imageUrl ?? '')))
const isSoldOut = computed(() => {
  // `!== undefined`, not a truthiness or nullish test: soldAt is null for an item
  // that is still on the market, so anything looser would fall through to the
  // `!detail` fallback and call every active item sold.
  const soldAt = (item.value as unknown as { soldAt?: string | null })?.soldAt
  if (soldAt !== undefined) return soldAt != null
  // if we have raw but no detail, treat as sold? keep fallback
  if (raw.value && !detail.value) return true
  return false
})

const parsed = computed(() => parseDetail(detail.value as never))
const attributes = computed(() => parsed.value.attributes)
const datas = computed(() => parsed.value.datas)

const basicSection = computed(() => datas.value.find(d => d.title.toLowerCase().includes('basic effect')) ?? null)
const gradeSection = computed(() => datas.value.find(d => d.title.toLowerCase().includes('grade effect')) ?? null)

const basicEntries = computed(() => basicSection.value ? simpleValues(basicSection.value as { title: string; values: unknown[] }) : [])
const gradeEntries = computed(() => gradeSection.value ? simpleValues(gradeSection.value as { title: string; values: unknown[] }) : [])

async function fetchDetail(id: number) {
  imgError.value = false
  isLive.value = false
  if (cache.has(id)) {
    raw.value = cache.get(id)!
    isLive.value = liveIds.has(id)
    return
  }
  loading.value = true
  try {
    const res = await window.api.marketplace.get(id)
    if (res) {
      raw.value = res
      cache.set(id, res)
      return
    }
    // Local miss → display-only live fetch (never persisted).
    const live = await window.api.marketplace.getLive(id).catch(() => null)
    const adapted = adaptLiveDetail(live as never, props.fallbackItem?.name ?? '')
    if (adapted) {
      raw.value = adapted
      cache.set(id, adapted)
      liveIds.add(id)
      isLive.value = true
    } else {
      raw.value = null
    }
  } catch {
    raw.value = null
  } finally {
    loading.value = false
  }
}

watch(() => props.open, async (open) => {
  if (!open || props.tokenId == null) return
  await fetchDetail(Number(props.tokenId))
})

watch(() => props.tokenId, async (id) => {
  if (!props.open || id == null) return
  await fetchDetail(Number(id))
})

function goFull() {
  if (props.tokenId == null) return
  emit('update:open', false)
  router.push(`/items/${props.tokenId}`)
}
</script>
