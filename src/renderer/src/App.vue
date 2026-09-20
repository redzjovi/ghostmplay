<template>
  <div class="min-h-screen bg-background text-foreground flex">
    <AppSidebar />
    <main class="flex-1 min-w-0 pb-8">
      <router-view />
    </main>
    <!-- Debug: current full URL (hash history) -->
    <template v-if="showDebug">
      <div
        v-if="!isMinimized"
        class="fixed bottom-0 inset-x-0 z-50 border-t bg-card/95 backdrop-blur px-3 py-1.5 text-[11px] font-mono flex items-center gap-2"
      >
        <span class="shrink-0 text-muted-foreground">URL:</span>
        <span class="truncate" :title="href">{{ href }}</span>
        <span class="shrink-0 opacity-50">|</span>
        <span class="truncate opacity-70" :title="route.fullPath">{{ route.fullPath }}</span>
        <Button variant="ghost" size="icon" class="ml-auto h-6 w-6" @click="copyHref" title="Copy full URL">
          <Copy class="h-3 w-3" />
        </Button>
        <Button variant="ghost" size="icon" class="h-6 w-6" @click="minimizeDebug" title="Minimize">
          <Minus class="h-3 w-3" />
        </Button>
      </div>
      <div
        v-else
        class="fixed bottom-2 right-2 z-50"
      >
        <Button variant="secondary" size="sm" class="h-7 gap-1.5 rounded-full shadow border text-[11px] font-mono" @click="isMinimized = false" title="Restore debug panel">
          <Bug class="h-3 w-3" /> Debug
        </Button>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import AppSidebar from '@/components/AppSidebar.vue'
import { ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { Copy, Minus, Bug } from 'lucide-vue-next'
import { Button } from '@/components/ui/button'

const route = useRoute()
const href = ref(typeof window !== 'undefined' ? window.location.href : '')
const showDebug = ref<boolean>(typeof window !== 'undefined' ? (import.meta.env.DEV || localStorage.getItem('ghostmplay:debug:url') === '1') : false)
const isMinimized = ref<boolean>(typeof window !== 'undefined' ? localStorage.getItem('ghostmplay:debug:minimized') !== '0' : true)

watch(
  () => route.fullPath,
  () => {
    href.value = window.location.href
  },
  { immediate: true }
)

watch(isMinimized, (v) => {
  localStorage.setItem('ghostmplay:debug:minimized', v ? '1' : '0')
})

function minimizeDebug() {
  isMinimized.value = true
}

if (typeof window !== 'undefined') {
  window.addEventListener('hashchange', () => {
    href.value = window.location.href
  })
  window.addEventListener('keydown', (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'u') {
      e.preventDefault()
      // if minimized, restore; else toggle hide
      if (showDebug.value && isMinimized.value) {
        isMinimized.value = false
      } else {
        showDebug.value = !showDebug.value
        if (showDebug.value) isMinimized.value = false
      }
      localStorage.setItem('ghostmplay:debug:url', showDebug.value ? '1' : '0')
    }
  })
}

function copyHref() {
  navigator.clipboard.writeText(href.value).catch(() => {})
  // also log for dev:debug correlation
  console.log('[debug URL]', { href: href.value, fullPath: route.fullPath, query: route.query })
}
</script>
