<template>
  <aside
    class="sticky top-0 flex h-screen shrink-0 flex-col border-r bg-card transition-all duration-300"
    :class="isCollapsed ? 'w-14' : 'w-14 md:w-60'"
  >
    <div class="flex items-center gap-2 px-3 py-4 md:px-5" :class="{ 'justify-center md:justify-start': isCollapsed }">
      <Gamepad2 class="h-5 w-5 shrink-0 text-primary" />
      <span v-show="!isCollapsed" class="hidden truncate text-lg font-bold md:block">GhostMPlay</span>
      <Button
        variant="ghost"
        size="icon"
        class="ml-auto hidden h-7 w-7 shrink-0 md:inline-flex"
        :class="{ 'hidden': isCollapsed }"
        @click="toggle"
        title="Collapse sidebar"
        aria-label="Collapse sidebar"
      >
        <PanelLeftClose class="h-4 w-4" />
      </Button>
    </div>
    <!-- Collapsed top toggle when isCollapsed -->
    <div v-if="isCollapsed" class="flex justify-center px-2 pb-2">
      <Button variant="ghost" size="icon" class="h-7 w-7" @click="toggle" title="Expand sidebar" aria-label="Expand sidebar">
        <PanelLeftOpen class="h-4 w-4" />
      </Button>
    </div>
    <nav class="flex flex-col gap-1 px-2 md:px-3">
      <router-link
        to="/"
        class="flex items-center gap-3 rounded-md px-2 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground md:px-3"
        :class="{ 'bg-accent text-accent-foreground': isMarketplace }"
        title="Marketplace"
      >
        <Store class="h-4 w-4 shrink-0" />
        <span v-show="!isCollapsed" class="hidden truncate md:block">Marketplace</span>
      </router-link>
    </nav>
    <div class="mt-auto flex items-center gap-2 p-2 md:p-3" :class="isCollapsed ? 'justify-center' : 'justify-between'">
      <ThemeToggle />
      <Button
        v-show="!isCollapsed"
        variant="ghost"
        size="icon"
        class="hidden h-7 w-7 shrink-0 md:inline-flex"
        @click="toggle"
        title="Minimize sidebar"
        aria-label="Minimize sidebar"
      >
        <ChevronsLeft class="h-4 w-4" />
      </Button>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { Gamepad2, Store, PanelLeftClose, PanelLeftOpen, ChevronsLeft } from 'lucide-vue-next'
import ThemeToggle from '@/components/ThemeToggle.vue'
import { Button } from '@/components/ui/button'

const route = useRoute()
const isMarketplace = computed(() => route.path === '/' || route.path.startsWith('/items'))

const STORAGE_KEY = 'ghostmplay:sidebar:collapsed'
const isCollapsed = ref<boolean>(localStorage.getItem(STORAGE_KEY) === '1')

function toggle() {
  isCollapsed.value = !isCollapsed.value
}
watch(isCollapsed, (v) => {
  localStorage.setItem(STORAGE_KEY, v ? '1' : '0')
  // also dispatch for App.vue if needed
  window.dispatchEvent(new CustomEvent('ghostmplay:sidebar-toggle', { detail: { collapsed: v } }))
})
</script>
