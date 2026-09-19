<template>
  <div class="page">
    <div class="header">
      <h2>Marketplace</h2>
      <button type="button" :disabled="syncing" class="sync-all-btn" @click="triggerAutoSync('all', true)">
        {{ syncing && syncMode==='all' ? 'Syncing All…' : 'Sync All' }}
      </button>
    </div>
    <div class="toolbar">
      <div class="multi-select" :class="{ open: equipOpen }" @click.stop>
        <button type="button" class="multi-select-toggle" @click="equipOpen = !equipOpen">
          <span class="multi-select-label">{{ equipmentTypeLabel }}</span> <span class="caret">▼</span>
        </button>
        <div v-if="equipOpen" class="multi-select-menu">
          <label class="multi-select-option"><input type="checkbox" :checked="selectedEquipmentTypes.length===0" @change="selectedEquipmentTypes=[]" /> All equipment types</label>
          <label v-for="t in (store.equipmentTypes.length?store.equipmentTypes:['Weapon','Armor','Accessory'])" :key="t" class="multi-select-option"><input type="checkbox" :value="t" v-model="selectedEquipmentTypes" /> {{ t }}</label>
        </div>
      </div>
      <div class="multi-select" :class="{ open: gradeOpen }" @click.stop>
        <button type="button" class="multi-select-toggle" @click="gradeOpen = !gradeOpen">
          <span class="multi-select-label">{{ gradeEffectLabel }}</span> <span class="caret">▼</span>
        </button>
        <div v-if="gradeOpen" class="multi-select-menu">
          <label class="multi-select-option"><input type="checkbox" :checked="selectedGradeEffects.length===0" @change="selectedGradeEffects=[]" /> All grade effects</label>
          <label v-for="g in (store.gradeEffects.length?store.gradeEffects:['Normal','Rare'])" :key="g" class="multi-select-option"><input type="checkbox" :value="g" v-model="selectedGradeEffects" /> {{ g }}</label>
        </div>
      </div>
      <input v-model="q" placeholder="Please enter your search term." @keyup.enter="onSearch" />
      <select v-model="sort" aria-label="Sort by">
        <option value="recent">Recently registered</option>
        <option value="price_desc">Price high to low</option>
        <option value="price_asc">Price low to high</option>
      </select>
      <div class="view-toggle" role="group" aria-label="View mode">
        <button type="button" :class="{ active: viewMode==='grid' }" :aria-pressed="viewMode==='grid'" @click="viewMode='grid'" title="Grid view">⊞ Grid</button>
        <button type="button" :class="{ active: viewMode==='list' }" :aria-pressed="viewMode==='list'" @click="viewMode='list'" title="List view">☰ List</button>
      </div>
    </div>
    <div v-if="activeFilters.length" class="chips" role="list" aria-label="Active filters">
      <span v-for="c in activeFilters" :key="c.key" class="chip" role="listitem">{{ c.label }} <button type="button" class="chip-remove" @click="c.clear()" :aria-label="`Remove ${c.label}`">×</button></span>
      <button v-if="activeFilters.length > 1" type="button" class="chip-clear" @click="clearAllFilters()">Clear all</button>
    </div>
    <p v-if="store.loading" class="hint">Loading…</p>
    <p v-if="syncing" class="hint">Syncing {{ syncMode }} (sort=created_at_desc, limit 12{{ syncMode==='latest' ? ', break on id+price' : '' }})…</p>
    <p class="hint">Total: {{ store.total }} · Showing {{ store.items.length }}<span v-if="lastSynced !== null"> · Last sync ({{ lastMode }}): {{ lastSynced }} new</span> · Page {{ page }}/{{ totalPages }}</p>
    <div :class="['grid', `view-${viewMode}`]">
      <article v-for="it in (store.items as Item[])" :key="it.tokenId" class="card">
        <router-link :to="`/items/${it.tokenId}`" class="item-image-link" :aria-label="`View ${it.name} details`" :title="it.name">
          <img :src="normalizeImageUrl(it.imageUrl)" :alt="it.name" loading="lazy" decoding="async" @error="(e:any)=>e.target.src='https://via.placeholder.com/320x320?text=No+Image'" />
        </router-link>
        <div class="info">
          <h3><router-link :to="`/items/${it.tokenId}`" class="item-name-link" :title="it.name">{{ it.name }}</router-link></h3>
          <div class="grid-metas">
            <p class="meta meta-type">{{ it.equipmentType }}</p>
            <p class="meta meta-level">Lv {{ it.level }}</p>
            <p v-if="it.enchant" class="meta meta-grade"><span>{{ it.gradeEffect }}</span> <span>+{{ it.enchant }}</span></p>
            <p v-else class="meta meta-grade"><span>{{ it.gradeEffect }}</span></p>
          </div>
          <div class="list-metas">
            <span class="meta">{{ it.equipmentType }}</span>
            <span class="meta">Lv {{ it.level }}</span>
            <span class="meta">{{ it.gradeEffect }}</span>
            <span v-if="it.enchant" class="meta">+{{ it.enchant }}</span>
          </div>
        </div>
        <p class="price" :class="{ 'with-icon': isNUMI(it.currency) }">
          <img v-if="isNUMI(it.currency)" :src="NUMI_ICON_URL" alt="NUMI" class="currency-icon" :width="viewMode==='list' ? 9 : 18" :height="viewMode==='list' ? 9 : 18" loading="lazy" decoding="async" @error="(e:any)=>(e.target as HTMLImageElement).style.display='none'" />
          <span>{{ it.price }}</span><span class="currency-text">{{ it.currency }}</span>
        </p>
      </article>
    </div>
    <div v-if="totalPages > 1" class="pagination" role="navigation" aria-label="Pagination">
      <button type="button" :disabled="page<=1" @click="load(page-1)">‹ Prev</button>
      <template v-for="n in pageNumbers" :key="n">
        <span v-if="n==='...'" class="ellipsis">…</span>
        <button v-else type="button" :class="{ active: n===page }" :disabled="n===page" @click="load(n as number)">{{ n }}</button>
      </template>
      <button type="button" :disabled="page>=totalPages" @click="load(page+1)">Next ›</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { useRoute } from 'vue-router'
import { useMarketplaceStore } from '../stores/marketplace'
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
  // dedupe ... if adjacent
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
  function onSearch() {
    page.value = 1
    load(1)
  }
async function triggerAutoSync(mode: 'all' | 'latest' = 'latest', force = false) {
  if (syncing.value) return
  // debounce via localStorage for mount (not for Ctrl+R force)
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

<style scoped>
.page{padding:20px}
.header{display:flex; align-items:center; justify-content:space-between; gap:12px}
.header h2{margin:0}
.sync-all-btn{background:#1e2533; color:#e6e8ee; border:1px solid #2a3447; padding:8px 14px; border-radius:8px; cursor:pointer; font-weight:600}
.sync-all-btn:disabled{opacity:0.6; cursor:not-allowed}
.sync-all-btn:hover:not(:disabled){background:#25304a}
.toolbar{display:flex; gap:8px; flex-wrap:wrap; margin:12px 0; align-items:center}
input,select{background:#111722; color:#e6e8ee; border:1px solid #2a3447; padding:8px 10px; border-radius:8px}
.chips{display:flex; flex-wrap:wrap; gap:6px; margin:8px 0}
.chip{display:inline-flex; align-items:center; gap:6px; background:#1e2533; border:1px solid #2a3447; color:#e6e8ee; border-radius:999px; padding:4px 10px; font-size:12px}
.chip-remove{background:transparent; border:0; color:#9aa3b2; cursor:pointer; padding:0 2px; font-size:14px; line-height:1}
.chip-remove:hover{color:#e6e8ee}
.chip-clear{margin-left:4px; background:transparent; border:0; color:#7aa5ff; cursor:pointer; font-size:12px}
.hint{color:#9aa3b2; font-size:13px}
.grid{display:grid; grid-template-columns: repeat(auto-fill, minmax(200px,1fr)); gap:14px; margin-top:12px}
.grid.view-list{display:flex; flex-direction:column; gap:6px}
.grid.view-list .card{display:grid; grid-template-columns:64px 1fr auto; gap:12px; align-items:center; padding:10px 12px; border-radius:10px}
.grid.view-list .card img{width:64px; height:64px; flex:0 0 64px; border-radius:8px}
.item-image-link{display:block; line-height:0; border-radius:8px; overflow:hidden}
.item-image-link:focus-visible{outline:2px solid #7aa5ff; outline-offset:2px}
.item-image-link:hover img{opacity:0.92}
.grid.view-list .item-image-link{width:64px; height:64px; flex:0 0 64px; border-radius:8px}
.grid.view-list .item-image-link img{width:64px; height:64px}
.grid.view-list .info{flex-direction:column; gap:2px; min-width:0; align-items:flex-start; text-align:left}
.grid.view-list .info h3{font-size:14px; line-height:1.25; font-weight:600; margin:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; width:100%; text-align:left}
.grid.view-list .grid-metas{display:none}
.grid.view-list .list-metas{display:flex; gap:6px; flex-wrap:wrap; align-items:center; width:100%}
.grid.view-list .list-metas .meta{font-size:11px; white-space:nowrap; margin:0; text-align:left}
.grid.view-list .price{margin:0; font-size:13px; min-width:96px; text-align:right; white-space:nowrap}
.grid.view-grid .card{padding:12px; gap:6px; border-radius:12px}
.grid.view-grid .info{display:flex; flex-direction:column; gap:3px; min-width:0; align-items:flex-start; text-align:left; width:100%}
.grid.view-grid .info h3{font-size:14px; line-height:1.25; margin:0; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; width:100%; text-align:left}
.grid.view-grid .list-metas{display:none}
.grid.view-grid .meta{font-size:11px; line-height:1.25; margin:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; text-align:left; width:100%}
.grid.view-grid .price{font-size:13px; margin-top:4px}
.card{background:#111722; border:1px solid #1e2533; border-radius:12px; padding:14px; display:flex; flex-direction:column; gap:10px}
.card img{width:100%; aspect-ratio:1; object-fit:cover; border-radius:8px; background:#0b0e14}
.meta{color:#9aa3b2; font-size:11px; line-height:1.2; margin:0; text-align:left}
.price{font-weight:700; display:inline-flex; align-items:center; gap:6px; line-height:1}

.item-name-link{color:#e6e8ee; text-decoration:none; display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap}
.item-name-link:hover{color:#7aa5ff; text-decoration:underline; text-underline-offset:2px}
.item-name-link:focus-visible{outline:2px solid #7aa5ff; outline-offset:2px; border-radius:2px}
.currency-icon{width:18px; height:18px; object-fit:contain; flex:0 0 18px; border-radius:4px; background:#0b0e14}
.grid.view-list .currency-icon{width:9px; height:9px; flex:0 0 9px; border-radius:3px}
.grid.view-list .price{gap:5px}
.currency-text{font-size:0.95em}
.dropdown{position:relative}
.dropdown-toggle{display:flex; align-items:center; gap:6px; background:#1e2533; color:#e6e8ee; border:1px solid #2a3447; padding:8px 12px; border-radius:8px; cursor:pointer}
.dropdown-toggle:disabled{opacity:0.6; cursor:not-allowed}
.caret{font-size:10px}
.dropdown-menu{position:absolute; top:100%; left:0; margin-top:6px; background:#111722; border:1px solid #2a3447; border-radius:8px; overflow:hidden; z-index:10; min-width:140px; display:flex; flex-direction:column}
.dropdown-menu button{background:transparent; color:#e6e8ee; border:0; padding:10px 12px; text-align:left; cursor:pointer}
.dropdown-menu button:hover{background:#1e2533}
.dropdown-menu button:disabled{opacity:0.6; cursor:not-allowed}
.view-toggle{display:flex; gap:6px; margin-left:auto; background:#111722; border:1px solid #2a3447; border-radius:8px; overflow:hidden}
.view-toggle button{background:transparent; color:#9aa3b2; border:0; padding:6px 10px; cursor:pointer}
.view-toggle button.active{background:#25304a; color:#e6e8ee}
.pagination{display:flex; gap:6px; justify-content:center; align-items:center; margin:16px 0}
.pagination button{background:#111722; color:#e6e8ee; border:1px solid #2a3447; padding:6px 10px; border-radius:6px; cursor:pointer}
.pagination button:disabled{opacity:0.5; cursor:not-allowed}
.pagination button.active{background:#7aa5ff; color:#0b0e14; border-color:#7aa5ff}
.ellipsis{color:#9aa3b2; padding:0 4px}
</style>
