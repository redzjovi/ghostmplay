<template>
  <div class="p-5 space-y-3">
    <div class="flex items-center justify-between gap-3">
      <h2 class="text-2xl font-semibold">Marketplace</h2>
      <Button :disabled="syncing" @click="triggerAutoSync('all', true)">
        <Loader2 v-if="syncing && syncMode==='all'" class="mr-2 h-4 w-4 animate-spin" />
        {{ syncing && syncMode==='all' ? 'Syncing All…' : 'Sync All' }}
      </Button>
    </div>

    <!-- Filter Section [equipment type] [grade effect] [input search] [button filter] + chips inside -->
    <div class="p-3 border rounded-lg bg-card space-y-3">
      <div class="flex flex-wrap gap-3 items-end">
        <!-- Equipment Type -->
        <div class="flex flex-col gap-1 w-[220px] shrink-0">
          <label class="text-xs font-medium text-muted-foreground">Equipment type</label>
          <Popover v-model:open="equipOpen">
            <PopoverTrigger as-child>
              <Button variant="outline" class="justify-between w-full max-w-[220px] overflow-hidden" :title="equipmentTypeFullTitle"><span class="truncate text-left flex-1">{{ equipmentTypeLabel }}</span> <ChevronDown class="ml-2 h-4 w-4 opacity-50 shrink-0" /></Button>
            </PopoverTrigger>
            <PopoverContent class="w-64 p-0">
              <Command>
                <CommandInput placeholder="Search ..." />
                <CommandList>
                  <CommandEmpty>No results</CommandEmpty>
                  <CommandGroup>
                    <div v-if="store.filterLoading" class="px-2 py-6 text-center text-sm text-muted-foreground">Loading…</div>
                    <div v-else-if="!store.equipmentTypes.length" class="px-2 py-6 text-center text-sm text-muted-foreground">No equipment types</div>
                  <CommandItem v-for="t in store.equipmentTypes" :key="t" :value="t" @select="() => toggleEquip(t)">
                    <span class="mr-2 grid h-4 w-4 shrink-0 place-content-center rounded-sm border border-primary" :class="selectedEquipmentTypes.includes(t) ? 'bg-primary text-primary-foreground' : 'text-transparent'"><Check class="h-4 w-4" /></span> {{ t }}
                  </CommandItem>
                  </CommandGroup>
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
        </div>

      <!-- Grade Effect -->
      <div class="flex flex-col gap-1 w-[200px] shrink-0">
        <label class="text-xs font-medium text-muted-foreground">Grade effect</label>
        <Popover v-model:open="gradeOpen">
          <PopoverTrigger as-child>
            <Button variant="outline" class="justify-between w-full max-w-[200px] overflow-hidden" :title="gradeEffectFullTitle"><span class="truncate text-left flex-1">{{ gradeEffectLabel }}</span> <ChevronDown class="ml-2 h-4 w-4 opacity-50 shrink-0" /></Button>
          </PopoverTrigger>
          <PopoverContent class="w-56 p-0">
              <Command>
                <CommandInput placeholder="Search ..." />
                <CommandList>
                  <CommandEmpty>No results</CommandEmpty>
                  <CommandGroup>
                    <div v-if="store.filterLoading" class="px-2 py-6 text-center text-sm text-muted-foreground">Loading…</div>
                    <div v-else-if="!store.gradeEffects.length" class="px-2 py-6 text-center text-sm text-muted-foreground">No grade effects</div>
                  <CommandItem v-for="g in store.gradeEffects" :key="g" :value="g" @select="() => toggleGrade(g)">
                    <span class="mr-2 grid h-4 w-4 shrink-0 place-content-center rounded-sm border border-primary" :class="selectedGradeEffects.includes(g) ? 'bg-primary text-primary-foreground' : 'text-transparent'"><Check class="h-4 w-4" /></span> {{ g }}
                  </CommandItem>
                  </CommandGroup>
                </CommandList>
              </Command>
          </PopoverContent>
        </Popover>
      </div>

        <!-- Input Search -->
        <div class="flex flex-col gap-1 flex-1 min-w-[200px]">
          <label class="text-xs font-medium text-muted-foreground">Search</label>
          <div class="relative">
            <Search class="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input v-model="q" placeholder="Please enter your search term." class="pl-8" @keyup.enter="load(1)" />
          </div>
        </div>
      </div>

      <!-- Chips inside filter section -->
      <div v-if="filterGroups.length" class="space-y-1.5 pt-3 border-t">
        <div v-for="g in filterGroups" :key="g.key" class="flex flex-wrap items-center gap-2">
          <span class="w-28 shrink-0 text-xs text-muted-foreground">{{ g.title }}</span>
          <Badge v-for="c in g.chips" :key="c.key" variant="secondary" class="gap-1">
            {{ c.label }} <Button variant="ghost" size="icon" class="h-3 w-3 p-0" @click="c.clear()"><X class="h-3 w-3" /></Button>
          </Badge>
          <Button v-if="g.chips.length>1" variant="ghost" size="icon" class="h-3 w-3 p-0" :title="`Clear ${g.title}`" :aria-label="`Clear ${g.title}`" @click="g.clearGroup()"><X class="h-3 w-3" /></Button>
        </div>
        <Button v-if="activeFilterCount>1" variant="ghost" size="sm" @click="clearAllFilters()">Clear all</Button>
      </div>
    </div>

    <!-- Row 2: Sort, Limit (new row) -->
    <div class="flex flex-wrap gap-2 items-center">
      <Select v-model="sort">
        <SelectTrigger class="w-[200px]">
          <SelectValue placeholder="Sort by" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="recent">Recently registered</SelectItem>
          <SelectItem value="price_desc">Price high to low</SelectItem>
          <SelectItem value="price_asc">Price low to high</SelectItem>
        </SelectContent>
      </Select>

      <Select :model-value="String(limit)" @update:model-value="(v:any)=>{ limit = Number(v) }">
        <SelectTrigger class="w-[110px]">
          <SelectValue placeholder="Per page" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem v-for="n in PAGE_SIZES" :key="n" :value="String(n)">{{ n }} / page</SelectItem>
        </SelectContent>
      </Select>

      <ToggleGroup type="single" :model-value="viewMode" @update:model-value="(v:any)=>viewMode=v || viewMode" class="ml-auto">
        <ToggleGroupItem value="grid" aria-label="Grid"><LayoutGrid class="h-4 w-4" /></ToggleGroupItem>
        <ToggleGroupItem value="list" aria-label="List"><List class="h-4 w-4" /></ToggleGroupItem>
      </ToggleGroup>
    </div>

    <div v-if="syncing" class="text-sm text-muted-foreground flex items-center gap-2"><Loader2 class="h-4 w-4 animate-spin" /> Syncing {{ syncMode }} (sort=created_at_desc, limit 12{{ syncMode==='latest' ? ', break on id+price' : '' }})…</div>
    <p class="text-sm text-muted-foreground">Total: {{ store.total }} · Showing {{ store.items.length }}<span v-if="lastSynced!==null"> · Last sync ({{ lastMode }}): {{ lastSynced }} new</span> · Page {{ page }}/{{ totalPages }}</p>

    <div :class="viewMode==='grid' ? 'grid gap-3 grid-cols-[repeat(auto-fill,minmax(200px,1fr))]' : 'flex flex-col gap-1.5'">
      <Card v-for="it in (store.items as Item[])" :key="it.tokenId" :class="[viewMode==='list' ? 'flex flex-row items-center gap-2 overflow-hidden' : 'flex flex-col gap-2 overflow-hidden', isSoldOut(it) ? 'opacity-60' : '']">
        <router-link :to="`/items/${it.tokenId}`" class="block overflow-hidden leading-[0] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring relative group" :class="viewMode==='list' ? 'rounded-l-lg w-12 shrink-0' : 'rounded-t-md'" :aria-label="`View ${it.name} details`" :title="it.name">
          <Badge v-if="isSoldOut(it)" variant="destructive" class="absolute top-1.5 left-1.5 z-10 text-[10px] px-1.5 py-0.5">Sold Out</Badge>
          <Button variant="secondary" size="icon" class="absolute top-1.5 right-1.5 z-10 h-7 w-7 rounded-full bg-background/90 backdrop-blur shadow opacity-90 hover:opacity-100" :class="viewMode==='list' ? 'hidden' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100'" title="Preview" aria-label="Preview" @click.stop.prevent="openPreview(it)"><Eye class="h-4 w-4" /></Button>
          <AspectRatio :ratio="1" class="relative w-full bg-muted overflow-hidden rounded-md">
            <Skeleton v-if="hasImage(it) && !imageLoaded(imageKey(it)) && !imageFailed(imageKey(it))" class="absolute inset-0 h-full w-full rounded-md" />
            <div v-if="!hasImage(it) || imageFailed(imageKey(it))" class="absolute inset-0 grid place-items-center bg-muted p-2 text-center">
              <div class="space-y-1">
                <div class="text-xs font-medium text-muted-foreground line-clamp-2 px-1">{{ it.name }}</div>
                <div class="text-[10px] text-muted-foreground/60">No Image</div>
              </div>
            </div>
            <img v-if="hasImage(it) && !imageFailed(imageKey(it))" :key="imageKey(it)" :src="normalizeImageUrl(it.imageUrl)" :alt="it.name" class="h-full w-full object-cover" :class="{ 'opacity-0': !imageLoaded(imageKey(it)), 'opacity-100 transition-opacity': imageLoaded(imageKey(it)) }" decoding="async" @load="markImageLoaded(imageKey(it))" @error="(e:any)=>onImageError(e, imageKey(it))" />
          </AspectRatio>
        </router-link>
        <template v-if="viewMode==='list'">
          <span class="min-w-0 flex-1 truncate text-sm font-medium"><router-link :to="`/items/${it.tokenId}`" class="hover:text-primary hover:underline underline-offset-2" :title="it.name">{{ it.name }}</router-link></span>
          <span class="shrink-0 whitespace-nowrap text-xs text-muted-foreground">{{ it.equipmentType }}</span>
          <span class="shrink-0 whitespace-nowrap text-xs text-muted-foreground">Lv {{ it.level }}</span>
          <span class="shrink-0 whitespace-nowrap text-xs text-muted-foreground">{{ it.gradeEffect }}</span>
          <span class="w-10 shrink-0 whitespace-nowrap text-right text-xs text-muted-foreground">{{ it.enchant ? '+' + it.enchant : '–' }}</span>
          <Button variant="ghost" size="icon" class="shrink-0 h-7 w-7" title="Preview" aria-label="Preview" @click.stop="openPreview(it)"><Eye class="h-4 w-4" /></Button>
        </template>
        <div v-else class="flex flex-col gap-1 min-w-0 px-3">
          <CardTitle class="text-sm leading-tight truncate"><router-link :to="`/items/${it.tokenId}`" class="hover:text-primary hover:underline underline-offset-2" :title="it.name">{{ it.name }}</router-link></CardTitle>
          <div class="flex flex-col gap-1">
            <Badge variant="outline" class="w-fit text-[11px]">{{ it.equipmentType }}</Badge>
            <span class="text-xs text-muted-foreground">Lv {{ it.level }}</span>
            <span v-if="it.enchant" class="text-xs text-muted-foreground"><span>{{ it.gradeEffect }}</span> <span>+{{ it.enchant }}</span></span>
            <span v-else class="text-xs text-muted-foreground">{{ it.gradeEffect }}</span>
          </div>
        </div>
        <div class="flex items-center gap-1 font-semibold" :class="viewMode==='list' ? 'text-sm min-w-[96px] justify-end pr-2' : 'text-sm px-3 pb-3'">
          <img v-if="isNUMI(it.currency)" :src="NUMI_ICON_URL" alt="NUMI" :class="viewMode==='list' ? 'h-4 w-4' : 'h-[18px] w-[18px]'" class="rounded object-contain bg-muted" decoding="async" @error="(e:any)=>(e.target as HTMLImageElement).style.display='none'" />
          <span>{{ formatPrice(it.price) }}</span><span class="text-xs font-normal text-muted-foreground">{{ it.currency }}</span>
        </div>
      </Card>
    </div>

    <div v-if="totalPages > 1" class="flex justify-center gap-1">
      <Button variant="outline" size="sm" :disabled="page<=1" @click="load(page-1)">‹ Prev</Button>
      <template v-for="n in pageNumbers" :key="n">
        <span v-if="n==='...'" class="px-2 text-muted-foreground">…</span>
        <Button v-else :variant="n===page ? 'default' : 'outline'" size="sm" :disabled="n===page" @click="load(n as number)">{{ n }}</Button>
      </template>
      <Button variant="outline" size="sm" :disabled="page>=totalPages" @click="load(page+1)">Next ›</Button>
    </div>

    <ItemPreviewDialog :tokenId="previewTokenId" :open="previewOpen" :fallbackItem="previewFallback" @update:open="previewOpen = $event" />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Search, LayoutGrid, List, ChevronDown, X, Loader2, Check, Eye } from 'lucide-vue-next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Card, CardTitle } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { AspectRatio } from '@/components/ui/aspect-ratio'
import { Skeleton } from '@/components/ui/skeleton'

import { useMarketplaceStore } from '@/stores/marketplace'
import type { GradeEffect } from '@shared/types'
import ItemPreviewDialog from '@/components/ItemPreviewDialog.vue'
import { formatPrice } from '@/lib/format'

const NUMI_ICON_URL = 'https://market.numine.io/images/market/icon_numi.png'
function isNUMI(currency?: string | number | null): boolean {
  if (currency == null) return false
  const s = String(currency).trim().toUpperCase()
  return s === 'NUMI' || s === '266'
}
function normalizeImageUrl(raw: string): string {
  if (!raw) return ''
  if (raw.includes('/ipfs/')) return raw
  const m = raw.match(/^(https?:\/\/[^\/]+)\/(Qm[1-9A-HJ-NP-Za-km-z]{44,}|bafy[a-z0-9]+.*|bafk[a-z0-9]+.*)$/i)
  if (m) return `${m[1]}/ipfs/${m[2]}`
  if (/^https?:\/\//.test(raw) || raw.startsWith('data:')) return raw
  return raw
}
type Item = { tokenId:number; name:string; imageUrl:string; equipmentType:string; level:number; enchant:number; gradeEffect:string; price:number; currency:string; mintTime?: string | null; createdAt?: string | null; sold?: boolean }
const store = useMarketplaceStore()
const loadedImages = ref<Set<string>>(new Set())
const errorImages = ref<Set<string>>(new Set())
function imageKey(it: Item): string {
  return `${it.tokenId}:${normalizeImageUrl(it.imageUrl)}`
}
function markImageLoaded(key: string) {
  loadedImages.value = new Set(loadedImages.value).add(key)
}
function onImageError(e: Event, key: string) {
  errorImages.value = new Set(errorImages.value).add(key)
  markImageLoaded(key)
  const img = e.target as HTMLImageElement
  img.style.display = 'none'
}
function hasImage(it: Item): boolean {
  return !!normalizeImageUrl(it.imageUrl)
}
function imageLoaded(key: string): boolean {
  return loadedImages.value.has(key)
}
function imageFailed(key: string): boolean {
  return errorImages.value.has(key)
}
function isSoldOut(it: Item): boolean {
  return !!it.sold
}

function parseArrayParam(v: unknown): string[] {
  if (!v) return []
  if (Array.isArray(v)) return v.flatMap((x) => String(x).split(',')).map((s) => s.trim()).filter(Boolean)
  return String(v).split(',').map((s) => s.trim()).filter(Boolean)
}
const route = useRoute()
const router = useRouter()
const q = ref(String(route.query.q || ''))
const selectedGradeEffects = ref<GradeEffect[]>(parseArrayParam(route.query.grade_effect) as GradeEffect[])
const selectedEquipmentTypes = ref<string[]>(parseArrayParam(route.query.equipment_type))
const equipOpen = ref(false)
const gradeOpen = ref(false)
const equipmentTypeFullTitle = computed(() => selectedEquipmentTypes.value.join(', '))
const gradeEffectFullTitle = computed(() => selectedGradeEffects.value.join(', '))
const equipmentTypeLabel = computed(() => {
  const v = selectedEquipmentTypes.value
  if (v.length === 0) return ''
  if (v.length === 1) return v[0]
  return `${v[0]} +${v.length - 1}` // generic: shows first + count, works for any N
})
const gradeEffectLabel = computed(() => {
  const v = selectedGradeEffects.value
  if (v.length === 0) return ''
  if (v.length === 1) return v[0]
  return `${v[0]} +${v.length - 1}`
})
function toggleEquip(v: string) {
  console.log('[vue] toggleEquip', v, 'before', [...selectedEquipmentTypes.value])
  const i = selectedEquipmentTypes.value.indexOf(v)
  if (i >= 0) selectedEquipmentTypes.value = selectedEquipmentTypes.value.filter((x) => x !== v)
  else selectedEquipmentTypes.value = [...selectedEquipmentTypes.value, v]
  console.log('[vue] toggleEquip after', [...selectedEquipmentTypes.value])
}
function toggleGrade(v: string) {
  console.log('[vue] toggleGrade', v, 'before', [...selectedGradeEffects.value])
  const i = selectedGradeEffects.value.indexOf(v as GradeEffect)
  if (i >= 0) selectedGradeEffects.value = selectedGradeEffects.value.filter((x) => x !== v)
  else selectedGradeEffects.value = [...selectedGradeEffects.value, v as GradeEffect]
  console.log('[vue] toggleGrade after', [...selectedGradeEffects.value])
}
const sort = ref<'recent' | 'price_asc' | 'price_desc'>(
  (route.query.sort as 'recent' | 'price_asc' | 'price_desc') || 'recent'
)
const page = ref<number>(Number(route.query.page) || 1)

const syncing = ref(false)
const syncMode = ref<'all' | 'latest'>('latest')
const lastSynced = ref<number | null>(null)
const lastMode = ref<'all' | 'latest' | null>(null)
const PAGE_SIZES = [12, 24, 48, 96]
const storedLimit = Number(route.query.limit ?? localStorage.getItem('ghostmplay:marketplace:limit') ?? 12)
const initialLimit = Number.isFinite(storedLimit) ? storedLimit : 12
const limit = ref(PAGE_SIZES.includes(initialLimit) ? initialLimit : 12)
watch(sort, (v) => {
  page.value = 1
  load(1)
})
watch(limit, (v) => {
  localStorage.setItem('ghostmplay:marketplace:limit', String(v))
  page.value = 1
  load(1)
})
const viewMode = ref<'grid' | 'list'>((localStorage.getItem('ghostmplay:marketplace:viewMode') as 'grid' | 'list') || 'grid')
watch(viewMode, (v) => localStorage.setItem('ghostmplay:marketplace:viewMode', v))
function syncUrl() {
  const query: Record<string, string> = {}
  if (page.value !== 1) query.page = String(page.value)
  if (limit.value !== 12) query.limit = String(limit.value)
  if (sort.value !== 'recent') query.sort = sort.value
  if (q.value.trim()) query.q = q.value.trim()
  if (selectedEquipmentTypes.value.length) query.equipment_type = selectedEquipmentTypes.value.join(',')
  if (selectedGradeEffects.value.length) query.grade_effect = selectedGradeEffects.value.join(',')
  router.replace({ path: '/', query })
}
const totalPages = computed(() => Math.max(1, Math.ceil(store.total / limit.value)))
const pageNumbers = computed<(number | string)[]>(() => {
  const total = totalPages.value
  const cur = page.value
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1)
  const pages: (number | string)[] = [1]
  if (cur > 3) pages.push('...')
  const start = Math.max(2, cur - 1)
  const end = Math.min(total - 1, cur + 1)
  for (let i = start; i <= end; i++) pages.push(i)
  if (cur < total - 2) pages.push('...')
  pages.push(total)
  return pages.filter((p, idx, arr) => !(p === '...' && arr[idx - 1] === '...'))
})
type FilterChip = { key: string; label: string; clear: () => void }
const filterGroups = computed(() => {
  const groups: { key: string; title: string; chips: FilterChip[]; clearGroup: () => void }[] = []
  if (selectedEquipmentTypes.value.length) groups.push({ key: 'equipmentType', title: 'Equipment type', chips: selectedEquipmentTypes.value.map((v) => ({ key: `equipmentType:${v}`, label: v, clear: () => { selectedEquipmentTypes.value = selectedEquipmentTypes.value.filter((x) => x !== v) } })).sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' })), clearGroup: () => { selectedEquipmentTypes.value = [] } })
  if (selectedGradeEffects.value.length) groups.push({ key: 'gradeEffect', title: 'Grade effect', chips: selectedGradeEffects.value.map((v) => ({ key: `gradeEffect:${v}`, label: v, clear: () => { selectedGradeEffects.value = selectedGradeEffects.value.filter((x) => x !== v) } })).sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' })), clearGroup: () => { selectedGradeEffects.value = [] } })
  if (q.value) groups.push({ key: 'q', title: 'Search', chips: [{ key: 'q', label: `“${q.value}”`, clear: () => { q.value = '' } }], clearGroup: () => { q.value = '' } })
  return groups
})
const activeFilterCount = computed(() => filterGroups.value.reduce((n, g) => n + g.chips.length, 0))
const hasActiveFilter = computed(() => q.value.trim().length > 0 || selectedEquipmentTypes.value.length > 0 || selectedGradeEffects.value.length > 0)
function clearAllFilters() {
  q.value = ''
  selectedEquipmentTypes.value = []
  selectedGradeEffects.value = []
}
function onClearFilters() {
  clearAllFilters()
  page.value = 1
  load(1)
}
  let qDebounce: ReturnType<typeof setTimeout> | null = null
  let filterDebounce: ReturnType<typeof setTimeout> | null = null
  watch(q, () => {
    if (qDebounce) clearTimeout(qDebounce)
    qDebounce = setTimeout(() => {
      page.value = 1
      load(1)
    }, 1000)
  })
  watch([() => [...selectedEquipmentTypes.value], () => [...selectedGradeEffects.value]], () => {
    console.log('[vue] filter watch fired', [...selectedEquipmentTypes.value], [...selectedGradeEffects.value])
    if (filterDebounce) clearTimeout(filterDebounce)
    filterDebounce = setTimeout(() => {
      page.value = 1
      load(1)
    }, 300)
  })
async function load(p = page.value) {
  console.log('[vue] load', { p, q: q.value, equipment_type: [...selectedEquipmentTypes.value], grade_effect: [...selectedGradeEffects.value] })
  page.value = Math.max(1, p)
  syncUrl()
  // keep loadedImages/errorImages across pages/filters per Fix C (stable key) — do not clear
  await store.fetchList({ 
    q: q.value || undefined, 
    grade_effect: selectedGradeEffects.value.length ? [...selectedGradeEffects.value] : undefined, 
    equipment_type: selectedEquipmentTypes.value.length ? [...selectedEquipmentTypes.value] : undefined, 
    sort: sort.value, 
    page: page.value,
    limit: limit.value,
 })
}
async function triggerAutoSync(mode: 'all' | 'latest' = 'latest', force = false) {
  if (syncing.value) return
  const AUTO_KEY = 'ghostmplay:marketplace:lastAutoSync'
  const MIN_INTERVAL = 60_000
  if (!force) {
    const last = Number(localStorage.getItem(AUTO_KEY) || 0)
    if (Date.now() - last < MIN_INTERVAL) return
  }
  if (!navigator.onLine) return
  syncing.value = true
  syncMode.value = mode
  try {
    const r = await store.refresh(q.value || undefined, mode)
    lastSynced.value = r.synced
    lastMode.value = mode
    if (r.synced > 0) {
      await store.fetchFilterOptions(true)
      pruneSelections()
      await load(page.value)
    }
    localStorage.setItem(AUTO_KEY, String(Date.now()))
  } catch (e) {
    console.error('auto sync failed', e)
  } finally {
    syncing.value = false
  }
}
watch(() => route.path, (to) => {
  if (to === '/') triggerAutoSync('latest')
})
function onKeydown(e: KeyboardEvent) {
  const isR = e.code === 'KeyR' || e.key.toLowerCase() === 'r'
  const isF5 = e.code === 'F5' || e.key === 'F5'
  if ((isR && (e.ctrlKey || e.metaKey)) || isF5) {
    if (route.path !== '/') return
    e.preventDefault()
    triggerAutoSync('latest', true)
  }
}
function pruneSelections() {
  const validTypes = new Set(store.equipmentTypes)
  const validGrades = new Set<string>(store.gradeEffects)
  const nextTypes = selectedEquipmentTypes.value.filter((v) => validTypes.has(v))
  const nextGrades = selectedGradeEffects.value.filter((v) => validGrades.has(v as string))
  if (JSON.stringify(nextTypes) !== JSON.stringify(selectedEquipmentTypes.value)) selectedEquipmentTypes.value = nextTypes
  if (JSON.stringify(nextGrades) !== JSON.stringify(selectedGradeEffects.value)) selectedGradeEffects.value = nextGrades
}
const previewTokenId = ref<number | null>(null)
const previewOpen = ref(false)
const previewFallback = ref<{ name: string; imageUrl: string; equipmentType: string } | null>(null)
function openPreview(it: Item) {
  previewTokenId.value = it.tokenId
  previewFallback.value = { name: it.name, imageUrl: it.imageUrl, equipmentType: it.equipmentType }
  previewOpen.value = true
}

onMounted(async () => {
  await Promise.all([load(), store.fetchFilterOptions()])
  pruneSelections()
  triggerAutoSync('latest')
  window.addEventListener('keydown', onKeydown)
})
onUnmounted(() => window.removeEventListener('keydown', onKeydown))
</script>
