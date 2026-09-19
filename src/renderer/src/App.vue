<template>
  <div class="min-h-screen bg-background text-foreground flex">
    <AppSidebar />
    <main class="flex-1 min-w-0">
      <router-view />
    </main>
  </div>
</template>

<script setup lang="ts">
import AppSidebar from '@/components/AppSidebar.vue'
</script>
