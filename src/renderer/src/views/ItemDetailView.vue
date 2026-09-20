<template>
  <div class="max-w-7xl mx-auto p-5 space-y-5">
    <Button variant="ghost" size="sm" @click="goBack">
      <ArrowLeft class="mr-2 h-4 w-4" /> Back to Marketplace
    </Button>

    <div v-if="loading" class="space-y-4">
      <Skeleton class="h-8 w-1/3" />
      <div class="grid grid-cols-1 md:grid-cols-[320px_1fr] gap-6">
        <Skeleton class="h-[320px] w-full rounded-lg" />
        <div class="space-y-3">
          <Skeleton class="h-6 w-3/4" />
          <Skeleton class="h-4 w-1/2" />
          <Skeleton class="h-10 w-full" />
        </div>
      </div>
      <Skeleton class="h-40 w-full" />
    </div>

    <div v-else-if="!item" class="space-y-3">
      <Alert variant="destructive">
        <AlertTitle>Item not found</AlertTitle>
        <AlertDescription>
          <p class="text-sm">Token #{{ tokenId }} not in local DB. It may not have been synced yet.</p>
          <pre v-if="rawData" class="whitespace-pre-wrap text-xs mt-2 p-2 bg-muted rounded">{{ JSON.stringify(rawData, null, 2) }}</pre>
          <Button size="sm" class="mt-3" @click="retry">Retry</Button>
        </AlertDescription>
      </Alert>
    </div>

    <div v-else class="space-y-5">
      <!-- Header -->
      <div class="flex flex-col md:flex-row md:items-center justify-between gap-2">
        <div class="space-y-1">
          <h1 class="text-2xl font-bold leading-tight flex flex-wrap items-center gap-2">
            <span>{{ item.name }}</span>
            <Badge v-if="isSoldOut" variant="destructive" class="text-xs">Sold Out</Badge>
          </h1>
          <p v-if="isSoldOut" class="text-xs text-muted-foreground">No detail (empty) — item sold out.</p>
        </div>
        <div class="flex items-center gap-2 font-semibold text-lg">
          <img v-if="isNUMI(item.currency)" :src="NUMI_ICON_URL" alt="NUMI" class="h-6 w-6 rounded object-contain bg-muted" />
          <span :class="isSoldOut ? 'line-through opacity-60' : ''">{{ formatPrice(item.price) }}</span>
          <span class="text-sm font-normal text-muted-foreground">{{ item.currency }}</span>
        </div>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-[340px_1fr] gap-6">
        <!-- Image -->
        <Card class="overflow-hidden" :class="isSoldOut ? 'opacity-70' : ''">
          <CardContent class="p-0">
            <AspectRatio :ratio="1" class="relative w-full bg-muted overflow-hidden">
              <Badge v-if="isSoldOut" variant="destructive" class="absolute top-2 left-2 z-10">Sold Out</Badge>
              <Skeleton v-if="!normalizeImageUrl(item.imageUrl) || imgError" class="absolute inset-0 h-full w-full" />
              <div v-if="!normalizeImageUrl(item.imageUrl) || imgError" class="absolute inset-0 grid place-items-center bg-muted p-4 text-center">
                <div class="space-y-2">
                  <ImageOff class="h-10 w-10 mx-auto opacity-30" />
                  <div class="text-sm font-medium line-clamp-2">{{ item.name }}</div>
                  <div class="text-xs text-muted-foreground">No Image</div>
                </div>
              </div>
              <img
                v-if="normalizeImageUrl(item.imageUrl) && !imgError"
                :src="normalizeImageUrl(item.imageUrl)"
                :alt="item.name"
                class="h-full w-full object-contain bg-white"
                :class="{ 'opacity-0': !imgLoaded, 'opacity-60': isSoldOut && imgLoaded, 'opacity-100 transition-opacity': imgLoaded && !isSoldOut }"
                decoding="async"
                @load="imgLoaded = true"
                @error="imgError = true"
              />
            </AspectRatio>
          </CardContent>
        </Card>

        <!-- Basic Info -->
        <div class="space-y-4">
          <Card>
            <CardHeader class="pb-3">
              <CardTitle class="text-base">Overview</CardTitle>
            </CardHeader>
            <CardContent class="space-y-3">
              <div class="flex flex-wrap gap-2">
                <Badge variant="secondary" class="gap-1"><Shield class="h-3 w-3" />{{ item.equipmentType }}</Badge>
                <Badge variant="outline">Lv {{ item.level }}</Badge>
                <Badge :variant="gradeVariant(item.gradeEffect)">{{ item.gradeEffect }}</Badge>
                <Badge v-if="item.enchant" variant="outline" class="gap-1"><Star class="h-3 w-3" /> +{{ item.enchant }}</Badge>
              </div>

              <div class="space-y-3 text-sm">
                <div class="space-y-1">
                  <div class="text-xs text-muted-foreground">Token ID</div>
                  <div class="font-mono font-medium">{{ item.tokenId }}</div>
                </div>
                <div class="space-y-1">
                  <div class="text-xs text-muted-foreground">Market Time</div>
                  <div class="font-mono text-xs">{{ formatDate(marketTime) }}</div>
                </div>
                <div class="space-y-1">
                  <div class="text-xs text-muted-foreground">Seller ID</div>
                  <div class="font-mono text-xs break-all" :title="item.sellerId">{{ item.sellerId }}</div>
                </div>
                <div class="space-y-1">
                  <div class="text-xs text-muted-foreground">Seller Name</div>
                  <div class="font-mono text-xs truncate" :title="item.sellerName ?? ''">{{ item.sellerName ?? '-' }}</div>
                </div>
              </div>
            </CardContent>
          </Card>

          <!-- Attributes -->
          <Card v-if="attributes.length">
            <CardHeader class="pb-3">
              <CardTitle class="text-base">Attributes</CardTitle>
            </CardHeader>
            <CardContent>
              <div class="grid grid-cols-2 gap-2">
                <div v-for="a in attributes" :key="a.type" class="flex justify-between items-center p-2.5 rounded-lg bg-muted/50 border">
                  <span class="text-xs text-muted-foreground">{{ a.type }}</span>
                  <span class="text-sm font-semibold">{{ a.value }}</span>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      <!-- Datas Sections — ordered [basic][spirit] / [grade][set composition] / [set effect] — Set Effect half -->
      <div v-if="orderedDatas.length" class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card v-for="section in orderedDatas" :key="section.title" class="overflow-hidden">
          <CardHeader class="pb-2">
            <CardTitle class="text-base flex items-center gap-2">
              <span class="h-2 w-2 rounded-full" :class="dotColor(section.title)"></span>
              {{ section.title }}
            </CardTitle>
          </CardHeader>
          <CardContent class="space-y-3">
            <!-- Simple values (Basic Effect, Spirit Synthesis, Grade Effect, Gem Effect) — max 2 cols -->
            <div v-if="isSimpleValues(section)" class="grid grid-cols-2 gap-2">
              <div v-for="(entry, idx) in simpleValues(section)" :key="idx" class="flex justify-between items-center p-2 rounded bg-muted/40 border">
                <span class="text-xs font-medium" :style="styleFor(entry.key)">{{ entry.key }}</span>
                <span class="text-sm font-semibold">{{ entry.value }}</span>
              </div>
            </div>

            <!-- Nested Set Effect etc. — max 2 cols -->
            <div v-else class="space-y-3">
              <div v-for="(sub, sIdx) in nestedValues(section)" :key="sIdx" class="rounded-lg border bg-muted/30 p-3 space-y-2">
                <div class="text-sm font-semibold">{{ sub.title }}</div>
                <div class="grid grid-cols-2 gap-2">
                  <div v-for="(entry, eIdx) in sub.entries" :key="eIdx" class="flex justify-between items-center p-2 rounded bg-background border">
                    <span class="text-xs" :style="styleFor(entry.key)">{{ entry.key }}</span>
                    <span class="text-xs font-semibold">{{ entry.value }}</span>
                  </div>
                </div>
              </div>
            </div>

            <!-- Fallback raw values -->
            <div v-if="!isSimpleValues(section) && nestedValues(section).length===0" class="text-xs">
              <pre class="whitespace-pre-wrap p-2 bg-muted rounded text-xs">{{ JSON.stringify(section.values, null, 2) }}</pre>
            </div>
          </CardContent>
        </Card>
      </div>

      <!-- Raw detail for debug (collapsed) — prismjs -->
      <details class="rounded-lg border p-3 bg-muted/20">
        <summary class="text-xs font-medium cursor-pointer">Raw detail (debug)</summary>
        <pre v-if="highlightedJson" class="language-json whitespace-pre-wrap text-[11px] mt-2 p-2 bg-background rounded border overflow-auto max-h-[400px] font-mono leading-relaxed" v-html="highlightedJson"></pre>
        <pre v-else class="whitespace-pre-wrap text-[11px] mt-2 p-2 bg-background rounded border overflow-auto max-h-[400px]">{{ fallbackJson }}</pre>
      </details>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ArrowLeft, Copy, Shield, Star, ImageOff } from 'lucide-vue-next'
import Prism from 'prismjs'
import 'prismjs/components/prism-json'
import 'prismjs/themes/prism-tomorrow.css'
import { formatPrice } from '@/lib/format'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { AspectRatio } from '@/components/ui/aspect-ratio'

const props = defineProps<{ tokenId: string }>()
const router = useRouter()
const loading = ref(true)
const data = ref<unknown>(null)
const imgError = ref(false)
const imgLoaded = ref(false)

function goBack() {
  if (window.history.length > 1) router.back()
  else router.replace('/')
}

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
function formatDate(d: string | Date | null): string {
  if (!d) return '-'
  try {
    const date = d instanceof Date ? d : new Date(d)
    if (isNaN(date.getTime())) return String(d)
    return new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZoneName: 'short' }).format(date)
  } catch { return String(d) }
}
function gradeVariant(g: string): 'default' | 'secondary' | 'outline' {
  const v = String(g).toLowerCase()
  if (v === 'rare') return 'default'
  if (v === 'legacy') return 'secondary'
  return 'outline'
}
function dotColor(title: string): string {
  const t = title.toLowerCase()
  if (t.includes('basic')) return 'bg-red-500'
  if (t.includes('spirit') || t.includes('gem')) return 'bg-emerald-500'
  if (t.includes('grade')) return 'bg-blue-500'
  if (t.includes('set composition')) return 'bg-purple-500'
  if (t.includes('set effect')) return 'bg-pink-500'
  return 'bg-primary'
}
function styleFor(word: string, cls?: string): string {
  const byClass: Record<string, string> = {
    section_red: 'color:#ef4444; font-weight: 700',
    section_blue: 'color:#3b82f6; font-weight: 700',
    section_sky: 'color:#0ea5e9; font-weight: 700',
    section_pink: 'color:#ec4899; font-weight: 700',
    section_green: 'color:#22c55e; font-weight: 700',
  }
  if (cls && byClass[cls]) return byClass[cls]
  return ''
}
function copyToken() {
  const t = String(props.tokenId)
  navigator.clipboard?.writeText(t).catch(()=>{})
}

type DetailItem = { tokenId:number; name:string; imageUrl:string; equipmentType:string; level:number; enchant:number; gradeEffect:string; price:number; currency:string; sellerId:string; sellerName:string | null; mintTime: string | Date | null; createdAt: string | Date; sold?: boolean }
type Detail = { itemId:number; attributes: unknown; datas: unknown; infos: unknown } | null

const rawData = computed(() => data.value)
const item = computed<DetailItem | null>(() => {
  const d = data.value as { item?: DetailItem; detail?: unknown } | null
  if (d?.item) return d.item
  const v = data.value as Record<string, unknown> | null
  if (v && typeof v.tokenId === 'number') return v as unknown as DetailItem
  return null
})
const detail = computed<Detail>(() => {
  const d = data.value as { detail?: Detail } | null
  return (d?.detail as Detail) ?? null
})
const attributes = computed(() => {
  const a = detail.value?.attributes
  if (!Array.isArray(a)) return [] as { type: string; value: string }[]
  return (a as Record<string, unknown>[]).map(x=>({ type: String((x as Record<string, unknown>).trait_type ?? (x as Record<string, unknown>).type ?? ''), value: String((x as Record<string, unknown>).value ?? '') })).filter(x=>x.type)
})
const datas = computed(() => {
  const d = detail.value?.datas
  if (!Array.isArray(d)) return [] as { title: string; class?: string; values: unknown[] }[]
  return (d as { title: string; class?: string; values: unknown[] }[]).map(x=>({ title: String(x.title ?? ''), class: String((x as Record<string,unknown>).class ?? ''), values: Array.isArray(x.values)? x.values : [] })).filter(x=>x.title)
})
const infos = computed(() => {
  const i = detail.value?.infos
  if (!Array.isArray(i)) return [] as { key: string; value: string }[]
  const out: { key: string; value: string }[] = []
  for (const rec of i as Record<string, unknown>[]) {
    for (const [k,v] of Object.entries(rec)) out.push({ key: String(k), value: String(v ?? '') })
  }
  return out
})
const mintTime = computed(()=> (item.value as unknown as { mintTime?: string | Date | null })?.mintTime ?? null)
const marketTime = computed(()=> (item.value as unknown as { createdAt?: string | Date | null })?.createdAt ?? null)
const rawDetail = computed(()=> detail.value)
// Sold out from DB flag sold (when detail empty at fetch time); fallback to detail empty for old rows
const isSoldOut = computed(() => {
  const soldFlag = (item.value as unknown as { sold?: boolean })?.sold
  if (soldFlag !== undefined) return !!soldFlag
  return !detail.value
})

// ordered datas: [basic effect] [spirit synthesis] / [grade effect] [set composition] / [set effect]
function orderIndex(title: string): number {
  const t = title.toLowerCase()
  if (t.includes('basic effect')) return 0
  if (t.includes('spirit synthesis') || t.includes('gem effect')) return 1
  if (t.includes('grade effect')) return 2
  if (t.includes('set composition')) return 3
  if (t.includes('set effect')) return 4
  return 99
}
const orderedDatas = computed(() => {
  return [...datas.value].sort((a, b) => orderIndex(a.title) - orderIndex(b.title))
})
const fallbackJson = computed(()=> JSON.stringify(rawDetail.value ?? data.value, null, 2))
const highlightedJson = computed(()=>{
  const raw = fallbackJson.value
  if(!raw) return ''
  try{
    return Prism.highlight(raw, Prism.languages.json, 'json')
  }catch{
    return ''
  }
})

// helpers for datas rendering
function isSimpleValues(section: { title: string; values: unknown[] }): boolean {
  if (!Array.isArray(section.values) || section.values.length===0) return true
  const first = section.values[0] as Record<string, unknown>
  // simple: {STR:"13"} or {DEX:6}
  // nested: {title:"[2] Set Effect", values:[{STR:15}]}
  return first && typeof first === 'object' && !('title' in first && 'values' in first)
}
function simpleValues(section: { title: string; values: unknown[] }): { key: string; value: string }[] {
  const out: { key: string; value: string }[] = []
  for (const v of section.values as Record<string, unknown>[]) {
    for (const [k,val] of Object.entries(v)) out.push({ key: k, value: String(val) })
  }
  return out
}
function nestedValues(section: { title: string; values: unknown[] }): { title: string; entries: { key: string; value: string }[] }[] {
  const out: { title: string; entries: { key: string; value: string }[] }[] = []
  for (const v of section.values as Record<string, unknown>[]) {
    if (v && typeof v === 'object' && 'title' in v && 'values' in v) {
      const title = String((v as Record<string, unknown>).title ?? '')
      const vals = (v as Record<string, unknown>).values as Record<string, unknown>[]
      const entries: { key: string; value: string }[] = []
      if (Array.isArray(vals)) for (const e of vals) for (const [k,val] of Object.entries(e)) entries.push({ key:k, value:String(val) })
      out.push({ title, entries })
    }
  }
  return out
}

function resetImg() { imgError.value=false; imgLoaded.value=false }
watch(()=>props.tokenId, resetImg)

async function fetch() {
  loading.value=true
  resetImg()
  try {
    const res = await window.api.marketplace.get(Number(props.tokenId))
    data.value = res
    if (!res) data.value = { tokenId: Number(props.tokenId), note: 'Not in local DB yet — run Sync from Marketplace.' }
  } catch {
    data.value = { error: 'Electron IPC unavailable. Run pnpm dev (Electron).' }
  } finally { loading.value=false }
}
function retry(){ fetch() }
onMounted(fetch)
</script>
