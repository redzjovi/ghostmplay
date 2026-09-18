<template>
  <div class="page">
    <h2>Marketplace</h2>
    <div class="toolbar">
      <input v-model="q" placeholder="Search name..." @keyup.enter="load" />
      <select v-model="gradeEffect">
        <option value="">All grades</option>
        <option value="Normal">Normal</option>
        <option value="Rare">Rare</option>
      </select>
      <select v-model="equipmentType">
        <option value="">All types</option>
        <option value="Weapon">Weapon</option>
        <option value="Armor">Armor</option>
        <option value="Accessory">Accessory</option>
      </select>
      <button type="button" :disabled="store.loading" @click="load">Search</button>
      <button type="button" @click="onRefresh">Sync from API</button>
    </div>
    <p v-if="store.loading" class="hint">Loading…</p>
    <p class="hint">Total: {{ store.total }} · Showing {{ store.items.length }}</p>
    <div class="grid">
      <article v-for="it in (store.items as Item[])" :key="it.tokenId" class="card">
        <img :src="it.imageUrl" :alt="it.name" loading="lazy" />
        <h3>{{ it.name }}</h3>
        <p class="meta">{{ it.equipmentType }} · Lv {{ it.level }} · +{{ it.enchant }} · {{ it.gradeEffect }}</p>
        <p class="price">{{ it.price }} {{ it.currency }}</p>
        <router-link :to="`/items/${it.tokenId}`">Detail →</router-link>
      </article>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useMarketplaceStore } from '../stores/marketplace'
import type { GradeEffect } from '@shared/types'
type Item = { tokenId:number; name:string; imageUrl:string; equipmentType:string; level:number; enchant:number; gradeEffect:string; price:number; currency:string }
const store = useMarketplaceStore()
const q = ref('')
const gradeEffect = ref<GradeEffect | ''>('')
const equipmentType = ref('')
async function load() {
  await store.fetchList({ q: q.value || undefined, gradeEffect: gradeEffect.value || undefined, equipmentType: equipmentType.value || undefined, page:1, limit:20 })
}
async function onRefresh() {
  const r = await store.refresh()
  await load()
  alert(`Synced ${r.synced} items (check main logs for real API mapping)`)
}
onMounted(load)
</script>

<style scoped>
.page{padding:20px}
.toolbar{display:flex; gap:8px; flex-wrap:wrap; margin:12px 0}
input,select{background:#111722; color:#e6e8ee; border:1px solid #2a3447; padding:8px 10px; border-radius:8px}
.hint{color:#9aa3b2; font-size:13px}
.grid{display:grid; grid-template-columns: repeat(auto-fill, minmax(220px,1fr)); gap:14px; margin-top:12px}
.card{background:#111722; border:1px solid #1e2533; border-radius:12px; padding:12px}
.card img{width:100%; aspect-ratio:1; object-fit:cover; border-radius:8px; background:#0b0e14}
.meta{color:#9aa3b2; font-size:12px}
.price{font-weight:700}
</style>
