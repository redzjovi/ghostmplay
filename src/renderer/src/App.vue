<template>
  <div class="min-h-screen bg-background text-foreground">
    <nav class="flex items-center gap-4 px-5 py-3 border-b bg-card">
      <router-link to="/" class="text-sm font-medium hover:text-primary">Home</router-link>
      <router-link to="/marketplace" class="text-sm font-medium hover:text-primary">Marketplace</router-link>
      <span class="flex-1" />
      <ThemeToggle />
      <Button variant="outline" size="sm" @click="onPing">{{ ping }}</Button>
    </nav>
    <router-view />
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { Button } from '@/components/ui/button'
import ThemeToggle from '@/components/ThemeToggle.vue'
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
