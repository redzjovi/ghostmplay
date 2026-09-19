<template>
  <div class="p-5 space-y-3">
    <div class="flex items-center justify-between gap-3">
      <h2 class="text-2xl font-semibold">Marketplace</h2>
      <Button :disabled="syncing" @click="triggerAutoSync('all', true)">
        <Loader2 v-if="syncing && syncMode==='all'" class="mr-2 h-4 w-4 animate-spin" />
        {{ syncing && syncMode==='all' ? 'Syncing All…' : 'Sync All' }}
      </Button>
    </div>

    <div class="flex flex-wrap gap-2 items-center">
      <!-- Equipment Type MultiSelect -->
      <Popover v-model:open="equipOpen">
        <PopoverTrigger as-child>
          <Button variant="outline" class="justify-between min-w-[180px]">{{ equipmentTypeLabel }} <ChevronDown class="ml-2 h-4 w-4 opacity-50" /></Button>
        </PopoverTrigger>
        <PopoverContent class="w-64 p-0">
          <Command>
            <CommandInput placeholder="Search type..." />
            <CommandList>
              <CommandEmpty>No results</CommandEmpty>
              <CommandGroup>
                <CommandItem :value="''" @select="selectedEquipmentTypes=[]">
                  <Checkbox :checked="selectedEquipmentTypes.length===0" class="mr-2" /> All equipment types
                </CommandItem>
                <CommandItem v-for="t in (store.equipmentTypes.length?store.equipmentTypes:['Weapon','Armor','Accessory'])" :key="t" :value="t" @select="toggleEquip(t)">
                  <Checkbox :checked="selectedEquipmentTypes.includes(t)" class="mr-2" /> {{ t }}
                </CommandItem>
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      <!-- Grade Effect MultiSelect -->
      <Popover v-model:open="gradeOpen">
        <PopoverTrigger as-child>
          <Button variant="outline" class="justify-between min-w-[160px]">{{ gradeEffectLabel }} <ChevronDown class="ml-2 h-4 w-4 opacity-50" /></Button>
        </PopoverTrigger>
        <PopoverContent class="w-56 p-0">
          <Command>
            <CommandList>
              <CommandGroup>
                <CommandItem :value="''" @select="selectedGradeEffects=[]">
                  <Checkbox :checked="selectedGradeEffects.length===0" class="mr-2" /> All grade effects
                </CommandItem>
                <CommandItem v-for="g in (store.gradeEffects.length?store.gradeEffects:['Normal','Rare'])" :key="g" :value="g" @select="toggleGrade(g)">
                  <Checkbox :checked="selectedGradeEffects.includes(g)" class="mr-2" /> {{ g }}
                </CommandItem>
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      <div class="relative flex-1 min-w-[200px]">
        <Search class="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
        <Input v-model="q" placeholder="Please enter your search term." class="pl-8" @keyup.enter="load(1)" />
      </div>

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

      <ToggleGroup type="single" :model-value="viewMode" @update:model-value="(v:any)=>viewMode=v || viewMode" class="ml-auto">
        <ToggleGroupItem value="grid" aria-label="Grid"><LayoutGrid class="h-4 w-4" /></ToggleGroupItem>
        <ToggleGroupItem value="list" aria-label="List"><List class="h-4 w-4" /></ToggleGroupItem>
      </ToggleGroup>
    </div>

    <div v-if="activeFilters.length" class="flex flex-wrap gap-2">
      <Badge v-for="c in activeFilters" :key="c.key" variant="secondary" class="gap-1">
        {{ c.label }} <Button variant="ghost" size="icon" class="h-3 w-3 p-0" @click="c.clear()"><X class="h-3 w-3" /></Button>
      </Badge>
      <Button v-if="activeFilters.length>1" variant="ghost" size="sm" @click="clearAllFilters()">Clear all</Button>
    </div>

    <div v-if="store.loading" class="space-y-2">
      <Skeleton v-for="i in 6" :key="i" class="h-20 w-full" />
    </div>
    <div v-else-if="syncing" class="text-sm text-muted-foreground">Syncing {{ syncMode }} (sort=created_at_desc, limit 12{{ syncMode==='latest' ? ', break on id+price' : '' }})…</div>
    <p class="text-sm text-muted-foreground">Total: {{ store.total }} · Showing {{ store.items.length }}<span v-if="lastSynced!==null"> · Last sync ({{ lastMode }}): {{ lastSynced }} new</span> · Page {{ page }}/{{ totalPages }}</p>

    <div :class="viewMode==='grid' ? 'grid gap-3 grid-cols-[repeat(auto-fill,minmax(200px,1fr))]' : 'flex flex-col gap-2'">
      <Card v-for="it in (store.items as Item[])" :key="it.tokenId" :class="viewMode==='list' ? 'flex flex-row items-center gap-3 p-3' : 'flex flex-col gap-2'">
        <router-link :to="`/items/${it.tokenId}`" class="block overflow-hidden rounded-md leading-[0] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" :aria-label="`View ${it.name} details`" :title="it.name">
          <AspectRatio :ratio="viewMode==='list' ? 1 : 1" :class="viewMode==='list' ? 'w-16' : 'w-full'">
            <img :src="normalizeImageUrl(it.imageUrl)" :alt="it.name" class="h-full w-full object-cover" loading="lazy" decoding="async" @error="(e:any)=>e.target.src='https://via.placeholder.com/320x320?text=No+Image'" />
          </AspectRatio>
        </router-link>
        <div :class="viewMode==='list' ? 'flex flex-1 flex-col gap-1 min-w-0' : 'flex flex-col gap-1 min-w-0'">
          <CardTitle class="text-sm leading-tight truncate"><router-link :to="`/items/${it.tokenId}`" class="hover:text-primary hover:underline underline-offset-2" :title="it.name">{{ it.name }}</router-link></CardTitle>
          <div v-if="viewMode==='grid'" class="flex flex-col gap-1">
            <Badge variant="outline" class="w-fit text-[11px]">{{ it.equipmentType }}</Badge>
            <span class="text-xs text-muted-foreground">Lv {{ it.level }}</span>
            <span v-if="it.enchant" class="text-xs text-muted-foreground"><span>{{ it.gradeEffect }}</span> <span>+{{ it.enchant }}</span></span>
            <span v-else class="text-xs text-muted-foreground">{{ it.gradeEffect }}</span>
          </div>
          <div v-else class="flex flex-wrap gap-1 items-center">
            <Badge variant="outline" class="text-[11px]">{{ it.equipmentType }}</Badge>
            <Badge variant="outline" class="text-[11px]">Lv {{ it.level }}</Badge>
            <Badge variant="outline" class="text-[11px]">{{ it.gradeEffect }}</Badge>
            <Badge v-if="it.enchant" variant="outline" class="text-[11px]">+{{ it.enchant }}</Badge>
          </div>
        </div>
        <div class="flex items-center gap-1 font-semibold" :class="viewMode==='list' ? 'text-xs min-w-[96px] justify-end' : 'text-sm'">
          <img v-if="isNUMI(it.currency)" :src="NUMI_ICON_URL" alt="NUMI" :class="viewMode==='list' ? 'h-[9px] w-[9px]' : 'h-[18px] w-[18px]'" class="rounded object-contain bg-muted" loading="lazy" decoding="async" @error="(e:any)=>(e.target as HTMLImageElement).style.display='none'" />
          <span>{{ it.price }}</span><span class="text-xs font-normal text-muted-foreground">{{ it.currency }}</span>
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
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { useRoute } from 'vue-router'
import { Search, LayoutGrid, List, ChevronDown, X, Loader2 } from 'lucide-vue-next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Card, CardTitle } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Checkbox } from '@/components/ui/checkbox'
import { AspectRatio } from '@/components/ui/aspect-ratio'
import { Skeleton } from '@/components/ui/skeleton'
import { useMarketplaceStore } from '@/stores/marketplace'
import type { GradeEffect } from '@shared/types'

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
type Item = { tokenId:number; name:string; imageUrl:string; equipmentType:string; level:number; enchant:number; gradeEffect:string; price:number; currency:string }
const store = useMarketplaceStore()
const q = ref('')
const selectedGradeEffects = ref<GradeEffect[]>(JSON.parse(localStorage.getItem('ghostmplay:marketplace:gradeEffects') || '[]'))
const selectedEquipmentTypes = ref<string[]>(JSON.parse(localStorage.getItem('ghostmplay:marketplace:equipmentTypes') || '[]'))
const equipOpen = ref(false)
const gradeOpen = ref(false)
const gradeEffectLabel = computed(() => selectedGradeEffects.value.length ? selectedGradeEffects.value.join(', ') : 'All grade effects')
const equipmentTypeLabel = computed(() => selectedEquipmentTypes.value.length ? selectedEquipmentTypes.value.join(', ') : 'All equipment types')
watch(selectedGradeEffects, (v) => localStorage.setItem('ghostmplay:marketplace:gradeEffects', JSON.stringify(v)), { deep: true })
watch(selectedEquipmentTypes, (v) => localStorage.setItem('ghostmplay:marketplace:equipmentTypes', JSON.stringify(v)), { deep: true })
function toggleEquip(v: string) {
  const i = selectedEquipmentTypes.value.indexOf(v)
  if (i >= 0) selectedEquipmentTypes.value.splice(i, 1)
  else selectedEquipmentTypes.value.push(v)
}
function toggleGrade(v: string) {
  const i = selectedGradeEffects.value.indexOf(v as GradeEffect)
  if (i >= 0) selectedGradeEffects.value.splice(i, 1)
  else selectedGradeEffects.value.push(v as GradeEffect)
}
const sort = ref<'recent' | 'price_asc' | 'price_desc'>((localStorage.getItem('ghostmplay:marketplace:sort') as 'recent' | 'price_asc' | 'price_desc') || 'recent')
watch(sort, (v) => {
  localStorage.setItem('ghostmplay:marketplace:sort', v)
  page.value = 1
  load(1)
})
const syncing = ref(false)
const syncMode = ref<'all' | 'latest'>('latest')
const lastSynced = ref<number | null>(null)
const lastMode = ref<'all' | 'latest' | null>(null)
const page = ref(1)
const limit = ref(12)
const viewMode = ref<'grid' | 'list'>((localStorage.getItem('ghostmplay:marketplace:viewMode') as 'grid' | 'list') || 'grid')
watch(viewMode, (v) => localStorage.setItem('ghostmplay:marketplace:viewMode', v))
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
const activeFilters = computed(() => {
  const chips: { key: string; label: string; clear: () => void }[] = []
  if (q.value) chips.push({ key: 'q', label: `“${q.value}”`, clear: () => { q.value = '' } })
  for (const v of selectedEquipmentTypes.value) chips.push({ key: `equipmentType:${v}`, label: v, clear: () => { selectedEquipmentTypes.value = selectedEquipmentTypes.value.filter((x) => x !== v) } })
  for (const v of selectedGradeEffects.value) chips.push({ key: `gradeEffect:${v}`, label: v, clear: () => { selectedGradeEffects.value = selectedGradeEffects.value.filter((x) => x !== v) } })
  return chips
})
function clearAllFilters() {
  q.value = ''
  selectedEquipmentTypes.value = []
  selectedGradeEffects.value = []
}
let qDebounce: ReturnType<typeof setTimeout> | null = null
watch([q, selectedEquipmentTypes, selectedGradeEffects], () => {
  if (qDebounce) clearTimeout(qDebounce)
  qDebounce = setTimeout(() => {
    page.value = 1
    load(1)
  }, 300)
}, { deep: true })
async function load(p = page.value) {
  page.value = Math.max(1, p)
  await store.fetchList({ q: q.value || undefined, gradeEffect: selectedGradeEffects.value.length ? selectedGradeEffects.value as GradeEffect[] : undefined, equipmentType: selectedEquipmentTypes.value.length ? selectedEquipmentTypes.value : undefined, sort: sort.value, page: page.value, limit: limit.value })
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
      page.value = 1
      await load(1)
    }
    localStorage.setItem(AUTO_KEY, String(Date.now()))
  } catch (e) {
    console.error('auto sync failed', e)
  } finally {
    syncing.value = false
  }
}
const route = useRoute()
watch(() => route.path, (to) => {
  if (to === '/marketplace') triggerAutoSync('latest')
})
function onKeydown(e: KeyboardEvent) {
  const isR = e.code === 'KeyR' || e.key.toLowerCase() === 'r'
  const isF5 = e.code === 'F5' || e.key === 'F5'
  if ((isR && (e.ctrlKey || e.metaKey)) || isF5) {
    if (route.path !== '/marketplace') return
    e.preventDefault()
    triggerAutoSync('latest', true)
  }
}
onMounted(async () => {
  await Promise.all([load(), store.fetchFilterOptions()])
  triggerAutoSync('latest')
  window.addEventListener('keydown', onKeydown)
})
onUnmounted(() => window.removeEventListener('keydown', onKeydown))
</script>
