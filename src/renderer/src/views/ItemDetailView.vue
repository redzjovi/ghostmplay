<template>
  <div class="max-w-3xl mx-auto p-5 space-y-4">
    <Button variant="ghost" size="sm" as-child>
      <router-link to="/marketplace"><ArrowLeft class="mr-2 h-4 w-4" /> Back</router-link>
    </Button>
    <h2 class="text-xl font-semibold">Item #{{ tokenId }}</h2>
    <div v-if="loading" class="space-y-3">
      <Skeleton class="h-40 w-full" />
      <Skeleton class="h-4 w-3/4" />
      <Skeleton class="h-4 w-1/2" />
    </div>
    <Card v-else-if="item">
      <CardContent class="pt-6">
        <div class="flex gap-4">
          <AspectRatio :ratio="1" class="w-40 overflow-hidden rounded-lg bg-muted">
            <img :src="normalizeImageUrl(item.imageUrl)" :alt="item.name" class="h-full w-full object-cover" @error="(e:any)=>e.target.src='https://via.placeholder.com/320x320?text=No+Image'" />
          </AspectRatio>
          <div class="flex flex-1 flex-col gap-2 min-w-0">
            <CardTitle class="text-lg">{{ item.name }}</CardTitle>
            <div class="flex flex-wrap gap-1">
              <Badge variant="secondary">{{ item.equipmentType }}</Badge>
              <Badge variant="outline">Lv {{ item.level }}</Badge>
              <Badge variant="outline">{{ item.gradeEffect }}</Badge>
              <Badge v-if="item.enchant" variant="outline">+{{ item.enchant }}</Badge>
            </div>
            <div class="flex items-center gap-2 font-semibold">
              <img v-if="isNUMI(item.currency)" :src="NUMI_ICON_URL" alt="NUMI" class="h-[22px] w-[22px] rounded object-contain bg-muted" loading="lazy" @error="(e:any)=>e.target.style.display='none'" />
              <span>{{ item.price }}</span><span class="text-sm font-normal text-muted-foreground">{{ item.currency }}</span>
            </div>
            <p class="text-xs text-muted-foreground">Token #{{ item.tokenId }} · Seller {{ item.sellerId }}</p>
          </div>
        </div>
      </CardContent>
    </Card>
    <Alert v-else variant="destructive">
      <AlertDescription><pre class="whitespace-pre-wrap text-xs">{{ JSON.stringify(data, null, 2) }}</pre></AlertDescription>
    </Alert>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { ArrowLeft } from 'lucide-vue-next'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { AspectRatio } from '@/components/ui/aspect-ratio'
const props = defineProps<{ tokenId: string }>()
const loading = ref(true)
const data = ref<unknown>(null)

const NUMI_ICON_URL = 'https://market.numine.io/images/market/icon_numi.png'
function isNUMI(currency?: string | number | null): boolean {
  if (currency == null) return false
  const s = String(currency).trim().toUpperCase()
  return s === 'NUMI' || s === '266'
}
function normalizeImageUrl(raw: string): string {
  if (!raw) return ''
  if (raw.includes('/ipfs/')) return raw
  const m = raw.match(/^(https?:\/\/[^\/]+)\/(Qm[1-9A-HJ-NP-Za-km-z]{44,}|bafy[a-z0-9]+.*|bafk[a-z0-9]+.*)$/i)
  if (m) return `${m[1]}/ipfs/${m[2]}`
  if (/^https?:\/\//.test(raw) || raw.startsWith('data:')) return raw
  return raw
}
const item = computed(() => {
  const d = data.value as { item?: { tokenId:number; name:string; imageUrl:string; equipmentType:string; level:number; enchant:number; gradeEffect:string; price:number; currency:string; sellerId:string }; detail?: unknown }
  return d?.item ?? (data.value as { tokenId?:number } && (data.value as Record<string,unknown>).tokenId ? data.value as never : null)
})
onMounted(async () => {
  try {
    data.value = await window.api.marketplace.get(Number(props.tokenId))
    if (!data.value) data.value = { tokenId: Number(props.tokenId), note: 'Not in local DB yet — run Sync from Marketplace.' }
  } catch {
    data.value = { error: 'Electron IPC unavailable in browser dev. Run pnpm dev (Electron) for real DB.' }
  } finally { loading.value = false }
})
</script>
