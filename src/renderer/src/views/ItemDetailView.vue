<template>
  <div class="page">
    <router-link to="/marketplace">← Back</router-link>
    <h2>Item #{{ tokenId }}</h2>
    <p v-if="loading" class="hint">Loading…</p>
    <div v-else-if="item" class="detail">
      <img :src="normalizeImageUrl(item.imageUrl)" :alt="item.name" class="detail-img" @error="(e:any)=>e.target.src='https://via.placeholder.com/320x320?text=No+Image'" />
      <div class="detail-info">
        <h3>{{ item.name }}</h3>
        <p class="meta">{{ item.equipmentType }} · Lv {{ item.level }} · +{{ item.enchant }} · {{ item.gradeEffect }}</p>
        <p class="price with-icon">
          <img v-if="isNUMI(item.currency)" :src="NUMI_ICON_URL" alt="NUMI" class="currency-icon detail" width="22" height="22" loading="lazy" @error="(e:any)=>e.target.style.display='none'" />
          <span>{{ item.price }}</span><span class="currency-text">{{ item.currency }}</span>
        </p>
        <p class="hint">Token #{{ item.tokenId }} · Seller {{ item.sellerId }}</p>
      </div>
    </div>
    <pre v-else class="block">{{ JSON.stringify(data, null, 2) }}</pre>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
const props = defineProps<{ tokenId: string }>()
const loading = ref(true)
const data = ref<unknown>(null)

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
const item = computed(() => {
  const d = data.value as { item?: { tokenId:number; name:string; imageUrl:string; equipmentType:string; level:number; enchant:number; gradeEffect:string; price:number; currency:string; sellerId:string }; detail?: unknown }
  return d?.item ?? (data.value as { tokenId?:number } && (data.value as Record<string,unknown>).tokenId ? data.value as never : null)
})
onMounted(async () => {
  try {
    data.value = await window.api.marketplace.get(Number(props.tokenId))
    if (!data.value) data.value = { tokenId: Number(props.tokenId), note: 'Not in local DB yet — run Sync from Marketplace.' }
  } catch {
    data.value = { error: 'Electron IPC unavailable in browser dev. Run pnpm dev (Electron) for real DB.' }
  } finally { loading.value = false }
})
</script>

<style scoped>
.page{padding:20px}
.hint{color:#9aa3b2}
.block{background:#111722; border:1px solid #1e2533; border-radius:10px; padding:12px; overflow:auto}
.detail{display:flex; gap:16px; align-items:flex-start; background:#111722; border:1px solid #1e2533; border-radius:12px; padding:16px; margin-top:12px}
.detail-img{width:160px; height:160px; object-fit:cover; border-radius:8px; background:#0b0e14; flex:0 0 160px}
.detail-info{display:flex; flex-direction:column; gap:8px; min-width:0}
.detail-info h3{margin:0; font-size:18px}
.price{display:inline-flex; align-items:center; gap:6px; font-weight:700; line-height:1; font-size:16px}
.currency-icon{width:18px; height:18px; object-fit:contain; flex:0 0 18px; border-radius:4px; background:#0b0e14}
.currency-icon.detail{width:22px; height:22px; flex:0 0 22px}
.meta{color:#9aa3b2; font-size:12px}
</style>
