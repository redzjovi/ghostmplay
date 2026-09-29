<template>
  <Dialog :open="open" @update:open="(v:boolean)=>emit('update:open', v)">
    <DialogContent class="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>Add favorite</DialogTitle>
        <DialogDescription>Save current filter, search and sort as a favorite with a unique name.</DialogDescription>
      </DialogHeader>
      <div class="space-y-3">
        <div class="space-y-1.5">
          <label class="text-sm font-medium">Name <span class="text-destructive">*</span></label>
          <Input v-model="name" placeholder="e.g. Rare Weapons low price" maxlength="50" @keyup.enter="onSave" />
          <p v-if="error" class="text-xs text-destructive">{{ error }}</p>
          <p class="text-xs text-muted-foreground">{{ name.length }}/50</p>
        </div>
        <div v-if="previewChips.length" class="space-y-1">
          <p class="text-xs font-medium text-muted-foreground">Will save:</p>
          <div class="flex flex-wrap gap-1.5">
            <Badge v-for="c in previewChips" :key="c" variant="secondary" class="text-xs">{{ c }}</Badge>
            <Badge variant="outline" class="text-xs">{{ sortLabel }}</Badge>
          </div>
          <p v-if="!hasAnyFilter" class="text-xs text-muted-foreground">No filters active — will save as “All items” (with sort).</p>
        </div>
      </div>
      <DialogFooter>
        <Button variant="outline" @click="emit('update:open', false)">Cancel</Button>
        <Button :disabled="!canSave || saving" @click="onSave">
          <Loader2 v-if="saving" class="mr-2 h-4 w-4 animate-spin" />
          Save
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { Loader2 } from 'lucide-vue-next'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'

const props = defineProps<{
  open: boolean
  q?: string
  equipmentTypes?: string[]
  gradeEffects?: string[]
  sort?: string
  existingNames?: string[]
}>()
const emit = defineEmits<{ (e:'update:open', v:boolean):void; (e:'save', name:string):void }>()

const name = ref('')
const error = ref('')
const saving = ref(false)

watch(() => props.open, (v) => {
  if (v) { name.value=''; error.value=''; saving.value=false }
})

const hasAnyFilter = computed(() => !!(props.q?.trim() || (props.equipmentTypes?.length) || (props.gradeEffects?.length)))

const previewChips = computed(() => {
  const chips: string[] = []
  if (props.q?.trim()) chips.push(`Search: “${props.q.trim()}”`)
  for (const t of props.equipmentTypes ?? []) chips.push(t)
  for (const g of props.gradeEffects ?? []) chips.push(g)
  return chips
})
const sortLabel = computed(() => {
  if (props.sort === 'price_asc') return 'Price low → high'
  if (props.sort === 'price_desc') return 'Price high → low'
  return 'Recently registered'
})
const canSave = computed(() => {
  const n = name.value.trim()
  if (!n) return false
  if (n.length > 50) return false
  return true
})

async function onSave() {
  error.value=''
  const n = name.value.trim()
  if (!n) { error.value='Name is required'; return }
  if (n.length > 50) { error.value='Max 50 chars'; return }
  if (props.existingNames?.some(x=> x.toLowerCase()===n.toLowerCase())) { error.value=`Favorite "${n}" already exists`; return }
  saving.value=true
  try {
    emit('save', n)
  } finally {
    saving.value=false
  }
}
</script>
