<template>
  <div class="p-5 space-y-3">
    <h2 class="text-2xl font-semibold">Settings</h2>

    <section class="p-3 border rounded-lg bg-card">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div class="space-y-0.5 min-w-0">
          <div class="text-sm font-medium">Appearance</div>
          <div class="text-xs text-muted-foreground">
            Follow your device setting, or pick light or dark. Saved in this browser.
          </div>
        </div>

        <ToggleGroup
          type="single"
          variant="outline"
          :model-value="preference"
          @update:model-value="onPreference"
          class="shrink-0"
        >
          <ToggleGroupItem value="system"><Monitor class="h-4 w-4" />System</ToggleGroupItem>
          <ToggleGroupItem value="light"><Sun class="h-4 w-4" />Light</ToggleGroupItem>
          <ToggleGroupItem value="dark"><Moon class="h-4 w-4" />Dark</ToggleGroupItem>
        </ToggleGroup>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { Monitor, Moon, Sun } from 'lucide-vue-next'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useTheme } from '@/composables/useTheme'

const { preference, setPreference } = useTheme()

/**
 * A single-value toggle group emits `undefined` when its selected item is
 * clicked again, because the click clears the selection. Appearance always has
 * a value, so that one is ignored rather than applied.
 */
function onPreference(value: unknown) {
  if (value === 'system' || value === 'light' || value === 'dark') setPreference(value)
}
</script>
