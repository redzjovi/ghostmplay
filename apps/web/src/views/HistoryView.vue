<template>
  <div class="p-5 space-y-3">
    <div class="flex items-center justify-between gap-3 flex-wrap">
      <h2 class="text-2xl font-semibold">History</h2>
      <!-- Passive only. The sync controls live on the admin Data page; this stays so
           an admin who kicked off a run still sees the data moving. -->
      <span v-if="sync.isAdmin" class="text-xs text-muted-foreground">{{ lastSyncedLabel }}</span>
    </div>

    <!-- Filters -->
    <div class="p-3 border rounded-lg bg-card space-y-3">
      <div class="grid gap-3 md:grid-cols-2">
        <div class="flex flex-col gap-1">
          <label class="text-xs font-medium text-muted-foreground">Seller address</label>
          <Input v-model="seller" placeholder="e.g. 0x…" @keyup.enter="load(1)" />
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-xs font-medium text-muted-foreground">Seller username</label>
          <Popover v-model:open="sellerNameOpen">
            <PopoverTrigger as-child>
              <Button variant="outline" role="combobox" :aria-expanded="sellerNameOpen" class="justify-between w-full overflow-hidden" :title="sellerName === 'all' ? 'All seller names' : sellerName"><span class="truncate text-left flex-1">{{ sellerName === 'all' ? 'Select seller...' : sellerName }}</span> <ChevronsUpDown class="ml-2 h-4 w-4 shrink-0 opacity-50" /></Button>
            </PopoverTrigger>
            <PopoverContent class="w-64 p-0" align="start">
              <Command>
                <CommandInput placeholder="Search ..." />
                <CommandList>
                  <CommandEmpty>No results</CommandEmpty>
                  <CommandGroup>
                    <div v-if="store.filterLoading" class="px-2 py-6 text-center text-sm text-muted-foreground">Loading…</div>
                    <div v-else-if="!store.sellerNames.length" class="px-2 py-6 text-center text-sm text-muted-foreground">No seller names</div>
                    <CommandItem value="__all" @select="() => selectSellerName('all')">
                      <Check :class="cn('mr-2 h-4 w-4', sellerName === 'all' ? 'opacity-100' : 'opacity-0')" /> All
                    </CommandItem>
                    <CommandItem v-for="n in store.sellerNames" :key="n" :value="n" @select="() => selectSellerName(n)">
                      <Check :class="cn('mr-2 h-4 w-4', sellerName === n ? 'opacity-100' : 'opacity-0')" /> {{ n }}
                    </CommandItem>
                  </CommandGroup>
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-xs font-medium text-muted-foreground">Buyer address</label>
          <Input v-model="buyer" placeholder="e.g. 0x…" @keyup.enter="load(1)" />
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-xs font-medium text-muted-foreground">Buyer username</label>
          <Popover v-model:open="buyerNameOpen">
            <PopoverTrigger as-child>
              <Button variant="outline" role="combobox" :aria-expanded="buyerNameOpen" class="justify-between w-full overflow-hidden" :title="buyerName === 'all' ? 'All buyer names' : buyerName"><span class="truncate text-left flex-1">{{ buyerName === 'all' ? 'Select buyer...' : buyerName }}</span> <ChevronsUpDown class="ml-2 h-4 w-4 shrink-0 opacity-50" /></Button>
            </PopoverTrigger>
            <PopoverContent class="w-64 p-0" align="start">
              <Command>
                <CommandInput placeholder="Search ..." />
                <CommandList>
                  <CommandEmpty>No results</CommandEmpty>
                  <CommandGroup>
                    <div v-if="store.filterLoading" class="px-2 py-6 text-center text-sm text-muted-foreground">Loading…</div>
                    <div v-else-if="!store.buyerNames.length" class="px-2 py-6 text-center text-sm text-muted-foreground">No buyer names</div>
                    <CommandItem value="__all" @select="() => selectBuyerName('all')">
                      <Check :class="cn('mr-2 h-4 w-4', buyerName === 'all' ? 'opacity-100' : 'opacity-0')" /> All
                    </CommandItem>
                    <CommandItem v-for="n in store.buyerNames" :key="n" :value="n" @select="() => selectBuyerName(n)">
                      <Check :class="cn('mr-2 h-4 w-4', buyerName === n ? 'opacity-100' : 'opacity-0')" /> {{ n }}
                    </CommandItem>
                  </CommandGroup>
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-xs font-medium text-muted-foreground">Item name</label>
          <Input v-model="itemName" placeholder="e.g. Gold Box" @keyup.enter="load(1)" />
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-xs font-medium text-muted-foreground">Claimed</label>
          <Select v-model="claimed">
            <SelectTrigger><SelectValue placeholder="All" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="unclaimed">Unclaimed</SelectItem>
              <SelectItem value="claimed">Claimed</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-xs font-medium text-muted-foreground">Token id</label>
          <Input v-model="tokenId" type="number" min="0" placeholder="e.g. 4949" @keyup.enter="load(1)" />
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-xs font-medium text-muted-foreground">Tx hash</label>
          <Input v-model="txHash" placeholder="e.g. 0x…" @keyup.enter="load(1)" />
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-xs font-medium text-muted-foreground">Price min</label>
          <Input v-model="priceMin" type="number" min="0" placeholder="e.g. 0" @keyup.enter="load(1)" />
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-xs font-medium text-muted-foreground">Price max</label>
          <Input v-model="priceMax" type="number" min="0" placeholder="e.g. 1000" @keyup.enter="load(1)" />
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-xs font-medium text-muted-foreground">Created from</label>
          <Popover v-model:open="createdFromOpen">
            <PopoverTrigger as-child>
              <Button variant="outline" class="justify-start text-left font-normal" :class="!createdFrom && 'text-muted-foreground'">
                <CalendarIcon class="mr-2 h-4 w-4" />
                {{ createdFrom ?? 'Pick a date' }}
              </Button>
            </PopoverTrigger>
            <PopoverContent class="w-auto p-0" align="start">
              <Calendar initial-focus @update:model-value="(d) => pickDate('from', d)" />
            </PopoverContent>
          </Popover>
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-xs font-medium text-muted-foreground">Created to</label>
          <Popover v-model:open="createdToOpen">
            <PopoverTrigger as-child>
              <Button variant="outline" class="justify-start text-left font-normal" :class="!createdTo && 'text-muted-foreground'">
                <CalendarIcon class="mr-2 h-4 w-4" />
                {{ createdTo ?? 'Pick a date' }}
              </Button>
            </PopoverTrigger>
            <PopoverContent class="w-auto p-0" align="start">
              <Calendar initial-focus @update:model-value="(d) => pickDate('to', d)" />
            </PopoverContent>
          </Popover>
        </div>
      </div>
      <div class="flex gap-2 items-center flex-wrap">
        <Button variant="default" size="sm" @click="load(1)">Apply</Button>
        <Button variant="ghost" size="sm" @click="clearFilters">Clear</Button>
      </div>
    </div>

    <!-- Sort + page size row -->
    <div class="flex flex-wrap gap-2 items-center">
      <Select v-model="sort">
        <SelectTrigger class="w-[200px]">
          <SelectValue placeholder="Sort by" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="recent">Recently registered</SelectItem>
          <SelectItem value="created_at_asc">Oldest first</SelectItem>
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
    </div>

    <p class="text-sm text-muted-foreground">Total: {{ store.total }} · Showing {{ store.items.length }}<span v-if="hist.lastSynced!==null"> · Last sync ({{ syncModeLabel(hist.mode) }}): {{ hist.lastSynced }} new</span><span v-if="lastEnriched!==null"> · Enriched {{ lastEnriched }}, claimed {{ lastClaimed }}</span> · Page {{ page }}/{{ totalPages }}</p>

    <div class="border rounded-lg overflow-x-auto">
      <table class="w-full text-sm">
        <thead class="bg-muted/50 text-muted-foreground">
          <tr>
            <th class="text-left font-medium px-3 py-2">Seller</th>
            <th class="text-left font-medium px-3 py-2">Buyer</th>
            <th class="text-left font-medium px-3 py-2">Item Name</th>
            <th class="text-right font-medium px-3 py-2">Price</th>
            <th class="text-left font-medium px-3 py-2">Created At</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="store.loading">
            <td colspan="5" class="px-3 py-8 text-center text-muted-foreground"><Loader2 class="mx-auto mb-2 h-6 w-6 animate-spin" /> Loading…</td>
          </tr>
          <tr v-else-if="!(store.items as Row[]).length">
            <td colspan="5" class="px-3 py-8 text-center text-muted-foreground">No transfers synced yet. An admin can start a run from the Data page.</td>
          </tr>
          <tr v-for="t in (store.items as Row[])" :key="t.id" class="border-t hover:bg-muted/30">
            <td class="px-3 py-2">
              <div class="flex items-center gap-1 max-w-[220px]">
                <span class="font-mono text-xs truncate flex-1 min-w-0" :title="t.sellerId">{{ shortAddr(t.sellerId) }}</span>
                <Button variant="ghost" size="icon" class="h-5 w-5 shrink-0" title="Copy seller address" aria-label="Copy seller address" @click="copyText(t.sellerId, `seller-${t.id}`)">
                  <Check v-if="copiedKey === `seller-${t.id}`" class="h-3 w-3 text-primary" />
                  <Copy v-else class="h-3 w-3" />
                </Button>
              </div>
              <div class="text-xs text-muted-foreground truncate max-w-[220px]" :title="t.sellerUsername ?? ''">{{ t.sellerUsername ?? '—' }}</div>
            </td>
            <td class="px-3 py-2">
              <div class="flex items-center gap-1 max-w-[220px]">
                <span class="font-mono text-xs truncate flex-1 min-w-0" :title="t.buyerId">{{ shortAddr(t.buyerId) }}</span>
                <Button variant="ghost" size="icon" class="h-5 w-5 shrink-0" title="Copy buyer address" aria-label="Copy buyer address" @click="copyText(t.buyerId, `buyer-${t.id}`)">
                  <Check v-if="copiedKey === `buyer-${t.id}`" class="h-3 w-3 text-primary" />
                  <Copy v-else class="h-3 w-3" />
                </Button>
              </div>
              <div class="text-xs text-muted-foreground truncate max-w-[220px]" :title="t.buyerUsername ?? ''">{{ t.buyerUsername ?? '—' }}</div>
            </td>
            <td class="px-3 py-2">
              <span class="font-medium">{{ t.itemName }}</span>
              <Badge v-if="t.claimed" variant="secondary" class="ml-2 text-[10px]">claimed</Badge>
              <div class="font-mono text-[11px] text-muted-foreground" :title="`Preview token ${t.tokenId}`">
                <button class="hover:text-primary hover:underline underline-offset-2" @click="openPreview(t.tokenId, t.itemName)">{{ t.tokenId }}</button>
              </div>
              <div class="flex items-center gap-1 max-w-[200px]">
                <span class="font-mono text-[11px] text-muted-foreground truncate flex-1 min-w-0" :title="t.txHash">{{ t.txHash }}</span>
                <Button variant="ghost" size="icon" class="h-5 w-5 shrink-0" title="Copy tx hash" aria-label="Copy tx hash" @click="copyText(t.txHash, `tx-${t.id}`)">
                  <Check v-if="copiedKey === `tx-${t.id}`" class="h-3 w-3 text-primary" />
                  <Copy v-else class="h-3 w-3" />
                </Button>
              </div>
            </td>
            <td class="px-3 py-2 text-right whitespace-nowrap font-semibold">
              <span class="inline-flex items-center gap-1">
                <img v-if="isNUMI(t.currency)" :src="NUMI_ICON_URL" alt="NUMI" class="h-4 w-4 shrink-0 rounded object-contain bg-muted" decoding="async" @error="(e:any)=>(e.target as HTMLImageElement).style.display='none'" />
                <span>{{ formatPrice(t.price) }}</span>
                <span class="text-xs font-normal text-muted-foreground">{{ t.currency }}</span>
              </span>
            </td>
            <td class="px-3 py-2 whitespace-nowrap text-xs text-muted-foreground">{{ formatDateTime(t.createdAt) }}</td>
          </tr>
        </tbody>
      </table>
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
import { ref, computed, watch, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Loader2, ChevronsUpDown, Check, Copy, Calendar as CalendarIcon } from 'lucide-vue-next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import Calendar from '@/components/ui/calendar/Calendar.vue'
import ItemPreviewDialog from '@/components/ItemPreviewDialog.vue'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { useHistoryStore } from '@/stores/history'
import { useSyncStore } from '@/stores/sync'
import { statOf } from '@/lib/syncPanel'
import { formatDateTime, formatPrice } from '@/lib/format'

const NUMI_ICON_URL = 'https://market.numine.io/images/market/icon_numi.png'
function isNUMI(currency?: string | number | null): boolean {
  if (currency == null) return false
  const s = String(currency).trim().toUpperCase()
  return s === 'NUMI' || s === '266'
}
import { cn } from '@/lib/utils'
import type { HistoryListQuery } from '@ghostmplay/shared'

type Row = { id:number; tokenId:number; sellerId:string; sellerUsername?:string|null; buyerId:string; buyerUsername?:string|null; itemName:string; price:number; currency:string; txHash:string; createdAt:string; claimed:boolean }

const store = useHistoryStore()
const route = useRoute()
const router = useRouter()

const seller = ref(String(route.query.seller ?? ''))
const buyer = ref(String(route.query.buyer ?? ''))
const sellerName = ref(String(route.query.sellerName ?? 'all') || 'all')
const buyerName = ref(String(route.query.buyerName ?? 'all') || 'all')
const sellerNameOpen = ref(false)
const buyerNameOpen = ref(false)
function selectSellerName(v: string) {
  sellerName.value = v
  sellerNameOpen.value = false
}
function selectBuyerName(v: string) {
  buyerName.value = v
  buyerNameOpen.value = false
}
const itemName = ref(String(route.query.itemName ?? route.query.q ?? ''))
const tokenId = ref(String(route.query.tokenId ?? ''))
const txHash = ref(String(route.query.txHash ?? ''))
const priceMin = ref(String(route.query.priceMin ?? ''))
const priceMax = ref(String(route.query.priceMax ?? ''))
function asText(v: unknown): string {
  return String(v ?? '').trim()
}
function parseQueryDate(v: unknown): string | undefined {
  if (typeof v !== 'string' || !v) return undefined
  const day = v.slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return undefined
  const d = new Date(`${day}T00:00:00Z`)
  return isNaN(d.getTime()) ? undefined : day
}
const createdFrom = ref<string | undefined>(parseQueryDate(route.query.createdFrom))
const createdTo = ref<string | undefined>(parseQueryDate(route.query.createdTo))
const createdFromOpen = ref(false)
const createdToOpen = ref(false)
function pickDate(which: 'from' | 'to', d: unknown) {
  // Calendar emit payload is used structurally only (YYYY-MM-DD string).
  const raw = Array.isArray(d) ? d[0] : d
  if (raw === null || raw === undefined) {
    if (which === 'from') createdFrom.value = undefined
    else createdTo.value = undefined
  } else {
    const day = String((raw as { toString(): string }).toString()).slice(0, 10)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return
    if (which === 'from') createdFrom.value = day
    else createdTo.value = day
  }
  if (which === 'from') createdFromOpen.value = false
  else createdToOpen.value = false
}
const claimed = ref<StringClaimed>((route.query.claimed as StringClaimed) || 'all')
type StringClaimed = 'all' | 'claimed' | 'unclaimed'
const sort = ref<HistoryListQuery['sort']>(normalizeSort(route.query.sort as string))
function normalizeSort(v: string | undefined): HistoryListQuery['sort'] {
  if (v === 'price_asc' || v === 'price_desc' || v === 'created_at_asc' || v === 'recent') return v
  return 'recent' // default + legacy 'created_at_desc' alias
}
const page = ref(Number(route.query.page) || 1)
const PAGE_SIZES = [15, 30, 60, 100]
const storedLimit = Number(route.query.limit ?? localStorage.getItem('ghostmplay:history:limit') ?? 15)
const limit = ref(PAGE_SIZES.includes(Number.isFinite(storedLimit) ? storedLimit : 15) ? (Number.isFinite(storedLimit) ? storedLimit : 15) : 15)

// Sync runs in the background server-side and is admin-only; see stores/sync.ts.
// The controls live on the admin Data page. This view only reads its own kind's
// status, so a marketplace sync neither shows up here nor reports its item count
// as history's.
const sync = useSyncStore()
const hist = computed(() => sync.forKind('history'))
// Read from the store rather than snapshotted after a self-triggered run, so the
// numbers are current no matter who started it.
const lastEnriched = computed(() => statOf(hist.value, 'enriched'))
const lastClaimed = computed(() => statOf(hist.value, 'claimed'))

function syncModeLabel(mode: string | null | undefined): string {
  if (mode === 'full') return 'Full'
  if (mode === 'latest') return 'Latest'
  return ''
}

function shortAddr(a: string): string {
  if (!a) return '—'
  return a.length > 14 ? `${a.slice(0,6)}…${a.slice(-4)}` : a
}
const copiedKey = ref<string | null>(null)
let copiedTimer: ReturnType<typeof setTimeout> | null = null
async function copyText(text: string, key: string) {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    return
  }
  copiedKey.value = key
  if (copiedTimer) clearTimeout(copiedTimer)
  copiedTimer = setTimeout(() => {
    copiedKey.value = null
  }, 1500)
}
const previewTokenId = ref<number | null>(null)
const previewOpen = ref(false)
const previewFallback = ref<{ name: string } | null>(null)
function openPreview(tokenId: number, itemName: string) {
  previewTokenId.value = tokenId
  previewFallback.value = { name: itemName }
  previewOpen.value = true
}

function buildQuery(): HistoryListQuery {
  const q: HistoryListQuery = { page: page.value, limit: limit.value, sort: sort.value }
  if (asText(seller.value)) q.seller = asText(seller.value)
  if (asText(buyer.value)) q.buyer = asText(buyer.value)
  if (sellerName.value && sellerName.value !== 'all') q.sellerName = sellerName.value
  if (buyerName.value && buyerName.value !== 'all') q.buyerName = buyerName.value
  if (asText(itemName.value)) q.itemName = asText(itemName.value)
  if (asText(tokenId.value) !== '' && Number.isFinite(Number(asText(tokenId.value)))) q.tokenId = Number(asText(tokenId.value))
  if (asText(txHash.value)) q.txHash = asText(txHash.value)
  if (priceMin.value !== '' && Number.isFinite(Number(priceMin.value))) q.priceMin = Number(priceMin.value)
  if (priceMax.value !== '' && Number.isFinite(Number(priceMax.value))) q.priceMax = Number(priceMax.value)
  if (createdFrom.value) q.createdFrom = createdFrom.value
  if (createdTo.value) q.createdTo = createdTo.value
  if (claimed.value === 'claimed') q.claimed = true
  else if (claimed.value === 'unclaimed') q.claimed = false
  return q
}

function syncUrl() {
  const query: Record<string,string> = {}
  if (page.value !== 1) query.page = String(page.value)
  if (limit.value !== 15) query.limit = String(limit.value)
  if (sort.value !== 'recent') query.sort = String(sort.value)
  if (asText(seller.value)) query.seller = asText(seller.value)
  if (asText(buyer.value)) query.buyer = asText(buyer.value)
  if (sellerName.value && sellerName.value !== 'all') query.sellerName = sellerName.value
  if (buyerName.value && buyerName.value !== 'all') query.buyerName = buyerName.value
  if (asText(itemName.value)) query.itemName = asText(itemName.value)
  if (asText(tokenId.value) !== '') query.tokenId = asText(tokenId.value)
  if (asText(txHash.value)) query.txHash = asText(txHash.value)
  if (priceMin.value !== '') query.priceMin = priceMin.value
  if (priceMax.value !== '') query.priceMax = priceMax.value
  if (createdFrom.value) query.createdFrom = createdFrom.value
  if (createdTo.value) query.createdTo = createdTo.value
  if (claimed.value !== 'all') query.claimed = claimed.value
  router.replace({ path: '/history/list', query })
}

async function load(p = page.value) {
  page.value = Math.max(1, p)
  syncUrl()
  await store.fetchList(buildQuery())
}

function clearFilters() {
  seller.value = ''; buyer.value = ''; itemName.value = ''
  tokenId.value = ''; txHash.value = ''
  sellerName.value = 'all'; buyerName.value = 'all'
  priceMin.value = ''; priceMax.value = ''
  createdFrom.value = undefined; createdTo.value = undefined
  claimed.value = 'all'; sort.value = 'recent'
  load(1)
}

const totalPages = computed(() => Math.max(1, Math.ceil(store.total / limit.value)))
const pageNumbers = computed<(number|string)[]>(() => {
  const total = totalPages.value
  const cur = page.value
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1)
  const pages: (number|string)[] = [1]
  if (cur > 3) pages.push('...')
  for (let i = Math.max(2, cur-1); i <= Math.min(total-1, cur+1); i++) pages.push(i)
  if (cur < total-2) pages.push('...')
  pages.push(total)
  return pages.filter((p, idx, arr) => !(p==='...' && arr[idx-1]==='...'))
})

// Page size applies immediately; all other filters submit via Apply.
watch(limit, () => {
  localStorage.setItem('ghostmplay:history:limit', String(limit.value))
  load(1)
})

const lastSyncedLabel = computed(() => {
  const at = hist.value.lastFinishedAt
  if (!at) return 'Not synced yet'
  const n = hist.value.lastSynced
  return `Last sync: ${formatDateTime(at)}${n === null ? '' : ` · ${n} new`}`
})

onMounted(async () => {
  await store.fetchFilterOptions().catch(() => {})
  await load(page.value)
  // No-op for non-admins.
  void sync.start()
})
</script>
