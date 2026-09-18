<template>
  <div class="app">
    <nav class="nav">
      <router-link to="/">Home</router-link>
      <router-link to="/marketplace">Marketplace</router-link>
      <span class="spacer" />
      <button type="button" @click="onPing">{{ ping }}</button>
    </nav>
    <router-view />
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
const ping = ref('ping')
async function onPing() {
  try {
    ping.value = await window.api.system.ping()
    setTimeout(() => (ping.value = 'ping'), 1500)
  } catch {
    ping.value = 'offline (dev)'
  }
}
</script>

<style>
* { box-sizing: border-box; }
body { margin: 0; font-family: ui-sans-serif, system-ui, sans-serif; background:#0b0e14; color:#e6e8ee; }
a { color:#7aa5ff; text-decoration:none; }
.nav { display:flex; gap:16px; padding:14px 20px; border-bottom:1px solid #1e2533; align-items:center; }
.spacer { flex:1; }
button { background:#1e2533; color:#e6e8ee; border:1px solid #2a3447; padding:6px 10px; border-radius:8px; cursor:pointer; }
</style>
