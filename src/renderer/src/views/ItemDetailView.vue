<template>
  <div class="page">
    <router-link to="/marketplace">← Back</router-link>
    <h2>Item #{{ tokenId }}</h2>
    <p v-if="loading" class="hint">Loading…</p>
    <pre v-else class="block">{{ JSON.stringify(data, null, 2) }}</pre>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
const props = defineProps<{ tokenId: string }>()
const loading = ref(true)
const data = ref<unknown>(null)
onMounted(async () => {
  try {
    data.value = await window.api.marketplace.get(Number(props.tokenId))
    if (!data.value) data.value = { tokenId: Number(props.tokenId), note: 'Not in local DB yet — run Sync from Marketplace, or add real API detail mapping.' }
  } catch {
    data.value = { error: 'Electron IPC unavailable in browser dev. Run pnpm dev (Electron) for real DB.' }
  } finally { loading.value = false }
})
</script>

<style scoped>
.page{padding:20px}
.hint{color:#9aa3b2}
.block{background:#111722; border:1px solid #1e2533; border-radius:10px; padding:12px; overflow:auto}
</style>
