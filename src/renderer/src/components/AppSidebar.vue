<template>
  <aside class="sticky top-0 flex h-screen w-14 shrink-0 flex-col border-r bg-card md:w-60">
    <div class="flex items-center gap-2 px-3 py-4 md:px-5">
      <Gamepad2 class="h-5 w-5 shrink-0 text-primary" />
      <span class="hidden truncate text-lg font-bold md:block">GhostMPlay</span>
    </div>
    <nav class="flex flex-col gap-1 px-2 md:px-3">
      <router-link
        to="/"
        class="flex items-center gap-3 rounded-md px-2 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground md:px-3"
        :class="{ 'bg-accent text-accent-foreground': isMarketplace }"
        title="Marketplace"
      >
        <Store class="h-4 w-4 shrink-0" />
        <span class="hidden truncate md:block">Marketplace</span>
      </router-link>
    </nav>
    <div class="mt-auto flex justify-center p-2 md:justify-start md:p-3">
      <ThemeToggle />
    </div>
  </aside>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { Gamepad2, Store } from 'lucide-vue-next'
import ThemeToggle from '@/components/ThemeToggle.vue'

const route = useRoute()
const isMarketplace = computed(() => route.path === '/' || route.path.startsWith('/items'))
</script>
