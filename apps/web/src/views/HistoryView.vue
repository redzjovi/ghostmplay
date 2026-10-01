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
          <Input v-model="seller" placeholder="e.g. 0x…" @keyup.enter="applyFilters()" />
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
          <Input v-model="buyer" placeholder="e.g. 0x…" @keyup.enter="applyFilters()" />
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
          <Input v-model="itemName" placeholder="e.g. Gold Box" @keyup.enter="applyFilters()" />
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
          <Input v-model="tokenId" type="number" min="0" placeholder="e.g. 4949" @keyup.enter="applyFilters()" />
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-xs font-medium text-muted-foreground">Tx hash</label>
          <Input v-model="txHash" placeholder="e.g. 0x…" @keyup.enter="applyFilters()" />
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-xs font-medium text-muted-foreground">Price min</label>
          <Input v-model="priceMin" type="number" min="0" placeholder="e.g. 0" @keyup.enter="applyFilters()" />
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-xs font-medium text-muted-foreground">Price max</label>
          <Input v-model="priceMax" type="number" min="0" placeholder="e.g. 1000" @keyup.enter="applyFilters()" />
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-xs font-medium text-muted-foreground">Created from</label>
          <Popover v-model:open="createdFromOpen">
            <PopoverTrigger as-child>
              <Button variant="outline" class="justify-start text-left font-normal" :class="!createdFrom && 'text-muted-foreground'">
                <CalendarIcon class="mr-2 h-4 w-4" />
                {{ createdFrom || 'Pick a date' }}
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
                {{ createdTo || 'Pick a date' }}
              </Button>
            </PopoverTrigger>
            <PopoverContent class="w-auto p-0" align="start">
              <Calendar initial-focus @update:model-value="(d) => pickDate('to', d)" />
            </PopoverContent>
          </Popover>
        </div>
      </div>
      <div class="flex gap-2 items-center flex-wrap">
        <Button variant="default" size="sm" @click="applyFilters()">Apply</Button>
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
                <button type="button" class="font-mono text-xs flex-1 min-w-0" :class="partyValueClass(seller === t.sellerId)" :title="t.sellerId" @click="filterBySellerAddress(t.sellerId)">{{ shortAddr(t.sellerId) }}</button>
                <Button variant="ghost" size="icon" class="h-5 w-5 shrink-0" title="Copy seller address" aria-label="Copy seller address" @click="copyText(t.sellerId, `seller-${t.id}`)">
                  <Check v-if="copiedKey === `seller-${t.id}`" class="h-3 w-3 text-primary" />
                  <Copy v-else class="h-3 w-3" />
                </Button>
              </div>
              <button v-if="t.sellerUsername" type="button" class="text-xs text-muted-foreground max-w-[220px]" :class="partyValueClass(sellerName === t.sellerUsername)" :title="t.sellerUsername" @click="filterBySellerName(t.sellerUsername)">{{ t.sellerUsername }}</button>
              <div v-else class="text-xs text-muted-foreground max-w-[220px]">—</div>
            </td>
            <td class="px-3 py-2">
              <div class="flex items-center gap-1 max-w-[220px]">
                <button type="button" class="font-mono text-xs flex-1 min-w-0" :class="partyValueClass(buyer === t.buyerId)" :title="t.buyerId" @click="filterByBuyerAddress(t.buyerId)">{{ shortAddr(t.buyerId) }}</button>
                <Button variant="ghost" size="icon" class="h-5 w-5 shrink-0" title="Copy buyer address" aria-label="Copy buyer address" @click="copyText(t.buyerId, `buyer-${t.id}`)">
                  <Check v-if="copiedKey === `buyer-${t.id}`" class="h-3 w-3 text-primary" />
                  <Copy v-else class="h-3 w-3" />
                </Button>
              </div>
              <button v-if="t.buyerUsername" type="button" class="text-xs text-muted-foreground max-w-[220px]" :class="partyValueClass(buyerName === t.buyerUsername)" :title="t.buyerUsername" @click="filterByBuyerName(t.buyerUsername)">{{ t.buyerUsername }}</button>
              <div v-else class="text-xs text-muted-foreground max-w-[220px]">—</div>
            </td>
            <td class="px-3 py-2">
              <span class="font-medium">{{ t.itemName }}</span>
              <Badge v-if="t.claimed" variant="secondary" class="ml-2 text-[10px]">claimed</Badge>
              <div class="flex items-center gap-1 font-mono text-[11px] text-muted-foreground">
                <span class="truncate" :title="`Token ${t.tokenId}`">{{ t.tokenId }}</span>
                <Button variant="ghost" size="icon" class="h-5 w-5 shrink-0" :title="`View ${t.itemName}`" :aria-label="`View ${t.itemName}`" @click="openPreview(t.tokenId, t.itemName)">
                  <Eye class="h-3 w-3" />
                </Button>
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

    <ListPagination :page="page" :limit="limit" :total="store.total" @update:page="goToPage" />

    <ItemPreviewDialog :tokenId="previewTokenId" :open="previewOpen" :fallbackItem="previewFallback" @update:open="previewOpen = $event" />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Loader2, ChevronsUpDown, Check, Copy, Eye, Calendar as CalendarIcon } from 'lucide-vue-next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import Calendar from '@/components/ui/calendar/Calendar.vue'
import ItemPreviewDialog from '@/components/ItemPreviewDialog.vue'
import ListPagination from '@/components/ListPagination.vue'
import {
  HISTORY_PAGE_SIZES,
  HISTORY_DEFAULT_LIMIT,
  HISTORY_LIMIT_KEY,
  buildHistoryQuery,
  clampPage,
  historyStateFromQuery,
  parseArrayParam,
  totalPageCount,
  type ClaimedFilter,
  type HistoryListState,
  type HistorySort,
} from '@/lib/listQuery'
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

// The URL is the source of truth for everything that shapes the result set. These
// refs mirror it and are rewritten from it on every route change, so Back and
// Forward move through the list instead of being swallowed.
const initialState = historyStateFromQuery(route.query, localStorage.getItem(HISTORY_LIMIT_KEY))
const seller = ref(initialState.seller)
const buyer = ref(initialState.buyer)
const sellerName = ref(initialState.sellerName)
const buyerName = ref(initialState.buyerName)
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
const itemName = ref(initialState.itemName)
const tokenId = ref(initialState.tokenId)
const txHash = ref(initialState.txHash)
const priceMin = ref(initialState.priceMin)
const priceMax = ref(initialState.priceMax)
const createdFrom = ref(initialState.createdFrom)
const createdTo = ref(initialState.createdTo)
const createdFromOpen = ref(false)
const createdToOpen = ref(false)
function pickDate(which: 'from' | 'to', d: unknown) {
  // Calendar emit payload is used structurally only (YYYY-MM-DD string).
  const raw = Array.isArray(d) ? d[0] : d
  if (raw === null || raw === undefined) {
    if (which === 'from') createdFrom.value = ''
    else createdTo.value = ''
  } else {
    const day = String((raw as { toString(): string }).toString()).slice(0, 10)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return
    if (which === 'from') createdFrom.value = day
    else createdTo.value = day
  }
  if (which === 'from') createdFromOpen.value = false
  else createdToOpen.value = false
}
const claimed = ref<ClaimedFilter>(initialState.claimed)
const sort = ref<HistorySort>(initialState.sort)
const page = ref(initialState.page)
const limit = ref(initialState.limit)
const PAGE_SIZES = HISTORY_PAGE_SIZES

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

/** The API query for what the refs currently describe. */
function buildQuery(): HistoryListQuery {
  const q: HistoryListQuery = { page: page.value, limit: limit.value, sort: sort.value }
  if (seller.value.trim()) q.seller = seller.value.trim()
  if (buyer.value.trim()) q.buyer = buyer.value.trim()
  if (sellerName.value && sellerName.value !== 'all') q.sellerName = sellerName.value
  if (buyerName.value && buyerName.value !== 'all') q.buyerName = buyerName.value
  if (itemName.value.trim()) q.itemName = itemName.value.trim()
  if (tokenId.value.trim() !== '' && Number.isFinite(Number(tokenId.value.trim()))) q.tokenId = Number(tokenId.value.trim())
  if (txHash.value.trim()) q.txHash = txHash.value.trim()
  if (priceMin.value.trim() !== '' && Number.isFinite(Number(priceMin.value.trim()))) q.priceMin = Number(priceMin.value.trim())
  if (priceMax.value.trim() !== '' && Number.isFinite(Number(priceMax.value.trim()))) q.priceMax = Number(priceMax.value.trim())
  if (createdFrom.value) q.createdFrom = createdFrom.value
  if (createdTo.value) q.createdTo = createdTo.value
  if (claimed.value === 'claimed') q.claimed = true
  else if (claimed.value === 'unclaimed') q.claimed = false
  return q
}

/** The same state expressed as list state, for the URL codec and comparison. */
function currentState(): HistoryListState {
  return {
    page: page.value,
    limit: limit.value,
    sort: sort.value,
    seller: seller.value.trim(),
    buyer: buyer.value.trim(),
    sellerName: sellerName.value,
    buyerName: buyerName.value,
    itemName: itemName.value.trim(),
    tokenId: tokenId.value.trim(),
    txHash: txHash.value.trim(),
    priceMin: priceMin.value.trim(),
    priceMax: priceMax.value.trim(),
    createdFrom: createdFrom.value,
    createdTo: createdTo.value,
    claimed: claimed.value,
  }
}

function applyState(s: HistoryListState) {
  seller.value = s.seller
  buyer.value = s.buyer
  sellerName.value = s.sellerName
  buyerName.value = s.buyerName
  itemName.value = s.itemName
  tokenId.value = s.tokenId
  txHash.value = s.txHash
  priceMin.value = s.priceMin
  priceMax.value = s.priceMax
  createdFrom.value = s.createdFrom
  createdTo.value = s.createdTo
  claimed.value = s.claimed
  sort.value = s.sort
  page.value = s.page
  limit.value = s.limit
}

/**
 * True when `query` already describes the current route. Comparing as CSV means
 * `?a=1&a=2` and `?a=1,2` count as the same place, which is what lets `commit`
 * stay idempotent while `applyState` writes the refs.
 */
function routeMatches(query: Record<string, string>): boolean {
  const keys = new Set([...Object.keys(route.query), ...Object.keys(query)])
  for (const k of keys) {
    if (parseArrayParam(route.query[k]).join(',') !== parseArrayParam(query[k]).join(',')) return false
  }
  return true
}

/**
 * Write a change to the URL. Push by default so Back undoes it; `replace` is for
 * corrections that should not add an entry (mount normalisation, clamping).
 */
function commit(patch: Partial<HistoryListState> = {}, opts: { replace?: boolean } = {}) {
  // Any change other than paging invalidates the current page.
  const paged = patch.page !== undefined ? patch : { ...patch, page: 1 }
  const next = { ...currentState(), ...paged }
  const query = buildHistoryQuery(next)
  // Nothing to navigate to. The route watcher below is what loads the new state,
  // so skipping here also skips the refetch.
  if (routeMatches(query)) return
  void (opts.replace ? router.replace({ path: '/history/list', query }) : router.push({ path: '/history/list', query }))
}

/** Fetches the page the refs describe. Never touches the URL. */
async function fetchPage() {
  await store.fetchList(buildQuery())
  const last = clampPage(page.value, store.total, limit.value)
  if (last !== page.value) {
    page.value = last
    commit({ page: last }, { replace: true })
  }
}

function goToPage(p: number) {
  commit({ page: Math.max(1, p) })
}

// Clicking a party value in a row drills the list down to it; clicking the value
// that is already active widens it back. commit() pushes, so Back undoes either
// step, and because no page is given it resets to the first page — the result set
// is a different one.
function filterBySellerAddress(v: string) {
  seller.value = seller.value === v ? '' : v
  commit({ seller: seller.value })
}
function filterByBuyerAddress(v: string) {
  buyer.value = buyer.value === v ? '' : v
  commit({ buyer: buyer.value })
}
function filterBySellerName(v: string) {
  // The username selects treat 'all' as unset, not the empty string.
  if (v && !store.sellerNames.includes(v)) store.sellerNames.push(v)
  sellerName.value = sellerName.value === v ? 'all' : v
  commit({ sellerName: sellerName.value })
}
function filterByBuyerName(v: string) {
  if (v && !store.buyerNames.includes(v)) store.buyerNames.push(v)
  buyerName.value = buyerName.value === v ? 'all' : v
  commit({ buyerName: buyerName.value })
}

/**
 * A value that matches the active filter is tinted, so it is obvious which party
 * narrowed the list. Everything else stays plain until hovered.
 */
function partyValueClass(active: boolean): string {
  return cn(
    'text-left truncate hover:text-primary hover:underline underline-offset-2',
    active && 'text-primary font-medium bg-primary/10 rounded-sm px-1',
  )
}

function applyFilters() {
  // Submitting the form goes back to the first page of the new result set.
  const { page: _page, ...filters } = currentState()
  commit({ ...filters, page: 1 })
}

function clearFilters() {
  seller.value = ''; buyer.value = ''; itemName.value = ''
  tokenId.value = ''; txHash.value = ''
  sellerName.value = 'all'; buyerName.value = 'all'
  priceMin.value = ''; priceMax.value = ''
  createdFrom.value = ''; createdTo.value = ''
  claimed.value = 'all'; sort.value = 'recent'
  commit({ seller: '', buyer: '', itemName: '', tokenId: '', txHash: '', sellerName: 'all', buyerName: 'all', priceMin: '', priceMax: '', createdFrom: '', createdTo: '', claimed: 'all', sort: 'recent' })
}

// The single place state is derived from the URL. Back, Forward and a pushed
// filter change all arrive here.
watch(
  () => route.fullPath,
  async () => {
    applyState(historyStateFromQuery(route.query, localStorage.getItem(HISTORY_LIMIT_KEY)))
    await fetchPage()
  },
)

const totalPages = computed(() => totalPageCount(store.total, limit.value))

// Page size and sort sit outside the form and apply immediately.
watch(limit, (v) => {
  localStorage.setItem(HISTORY_LIMIT_KEY, String(v))
  commit({ limit: v })
})
watch(sort, (v) => commit({ sort: v }))

const lastSyncedLabel = computed(() => {
  const at = hist.value.lastFinishedAt
  if (!at) return 'Not synced yet'
  const n = hist.value.lastSynced
  return `Last sync: ${formatDateTime(at)}${n === null ? '' : ` · ${n} new`}`
})

onMounted(async () => {
  await store.fetchFilterOptions().catch(() => {})
  // A bare URL carries no page size, but one may be remembered from a previous
  // visit. Replace (never push) so the URL becomes shareable without adding an
  // entry the user never asked for. The replace lands in the route watcher, which
  // does the first load — hence the flag instead of a fetch on both paths.
  const normalized = buildHistoryQuery(currentState())
  const needsNormalize = !routeMatches(normalized)
  if (needsNormalize) router.replace({ path: '/history/list', query: normalized })
  if (!needsNormalize) await fetchPage()
  // No-op for non-admins.
  void sync.start()
})
</script>
