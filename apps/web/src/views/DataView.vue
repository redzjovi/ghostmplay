<template>
  <div class="p-5 space-y-3">
    <div class="flex items-center justify-between gap-3 flex-wrap">
      <h2 class="text-2xl font-semibold">Data</h2>
      <Badge variant="secondary">Admin only</Badge>
    </div>

    <p class="text-sm text-muted-foreground">
      Scraper controls. Both kinds also run automatically every minute, so a manual
      trigger mostly joins a run that is already going. A run is deduplicated by the
      server on a per-kind lock, so a double-click cannot start a second scrape.
    </p>

    <Alert v-if="sync.error" variant="destructive" class="py-2">
      <AlertDescription>{{ sync.error }}</AlertDescription>
    </Alert>

    <Card v-for="kind in PANEL_KINDS" :key="kind">
      <CardHeader>
        <div class="flex items-center justify-between gap-2 flex-wrap">
          <CardTitle class="text-base">{{ KIND_TITLES[kind] }}</CardTitle>
          <div class="flex items-center gap-2">
            <Badge v-if="byKind[kind].running" variant="default">
              <Loader2 class="mr-1 h-3 w-3 animate-spin" />
              {{ modeLabel(byKind[kind].mode) }} running
            </Badge>
            <Badge v-else-if="byKind[kind].lastStatus === 'failed'" variant="destructive">
              {{ statusLabel(byKind[kind]) }}
            </Badge>
            <Badge v-else :variant="byKind[kind].lastStatus === 'done' ? 'secondary' : 'outline'">
              {{ statusLabel(byKind[kind]) }}
            </Badge>
          </div>
        </div>
        <CardDescription>{{ KIND_BLURBS[kind] }}</CardDescription>
      </CardHeader>

      <CardContent class="space-y-3">
        <dl class="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
          <div>
            <dt class="text-xs text-muted-foreground">Last finished</dt>
            <dd>{{ finishedLabel(byKind[kind]) }}</dd>
          </div>
          <div>
            <dt class="text-xs text-muted-foreground">Last mode</dt>
            <dd>{{ modeLabel(byKind[kind].mode) }}</dd>
          </div>
          <div v-for="s in statsFor(kind)" :key="s.key">
            <dt class="text-xs text-muted-foreground">{{ s.label }}</dt>
            <dd>{{ s.value === null ? '—' : s.value }}</dd>
          </div>
        </dl>

        <p v-if="byKind[kind].lastError" class="text-xs text-destructive">
          Last run failed: {{ byKind[kind].lastError }}
        </p>

        <div class="flex items-center gap-2 flex-wrap">
          <Button
            variant="outline"
            :disabled="isBusy(kind)"
            @click="trigger(kind, 'latest')"
          >
            <Loader2 v-if="spinning(kind, 'latest')" class="mr-2 h-4 w-4 animate-spin" />
            {{ buttonLabel('latest') }}
          </Button>
          <Button :disabled="isBusy(kind)" @click="trigger(kind, backfillMode(kind))">
            <Loader2 v-if="spinning(kind, backfillMode(kind))" class="mr-2 h-4 w-4 animate-spin" />
            {{ buttonLabel(backfillMode(kind)) }}
          </Button>
          <span class="text-xs text-muted-foreground">
            <template v-if="deduped[kind]">Joined the run already in progress.</template>
          </span>
          <Button
            variant="destructive"
            class="ml-auto"
            :disabled="isBusy(kind) || clearing === kind"
            @click="askClear(kind)"
          >
            <Loader2 v-if="clearing === kind" class="mr-2 h-4 w-4 animate-spin" />
            Clear all
          </Button>
        </div>
      </CardContent>
    </Card>

    <!-- One dialog per section, because what happens after the delete is not the
         same: the marketplace refills itself within a minute, history does not. -->
    <Dialog :open="clearing !== null" @update:open="onDialogChange">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete all {{ clearing ? KIND_TITLES[clearing] : '' }} data?</DialogTitle>
          <DialogDescription>{{ clearing ? CLEAR_WARNINGS[clearing] : '' }}</DialogDescription>
        </DialogHeader>
        <p v-if="cleared" class="text-sm font-medium">{{ clearedSummary(cleared) }}</p>
        <DialogFooter>
          <Button variant="outline" @click="clearing = null">
            {{ cleared ? 'Close' : 'Cancel' }}
          </Button>
          <Button
            variant="destructive"
            :disabled="clearing === null || clearingNow || cleared !== null"
            @click="confirmClear"
          >
            <Loader2 v-if="clearingNow" class="mr-2 h-4 w-4 animate-spin" />
            Delete everything
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { Loader2 } from 'lucide-vue-next'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useSyncStore } from '@/stores/sync'
import { formatDateTime } from '@/lib/format'
import type { SyncKind, SyncKindStatus, ClearSyncDataResult } from '@/api/http-client'
import {
  PANEL_KINDS,
  backfillMode,
  modeLabel,
  statOf,
  statusLabel,
} from '@/lib/syncPanel'

const KIND_TITLES: Record<SyncKind, string> = {
  marketplace: 'Marketplace',
  history: 'History',
}

const KIND_BLURBS: Record<SyncKind, string> = {
  marketplace: 'Scrapes the live item list. Sync All walks every page from the start.',
  history: 'Scrapes the transfer log, which is also what decides sold state.',
}

/**
 * What each clear costs, stated before the click rather than after it. The two
 * sections are not equivalent: the marketplace's incremental run breaks on the
 * first item it already has, which an empty table has none of, so it re-walks
 * every page on the next cron tick and refills by itself. History's incremental
 * run only ever fetches the first page, so a cleared ledger stays empty until
 * somebody starts a full backfill.
 */
const CLEAR_WARNINGS: Record<SyncKind, string> = {
  marketplace:
    'Every listing and its detail data will be deleted. This cannot be undone. It will start refilling on its own within about a minute, and sold state is rebuilt from the transfer log rather than restored.',
  history:
    'Every transfer will be deleted. This cannot be undone, and it will NOT refill on its own — rebuilding it means a full backfill over every page the market holds, which takes hours.',
}

/**
 * Which stats are worth showing. Both kinds report `synced`; the rest are the
 * extras the scrapers put in the stats blob, and they differ per kind — showing
 * history's `enriched` on a marketplace row would just render an em dash.
 */
const KIND_STATS: Record<SyncKind, { key: string; label: string }[]> = {
  marketplace: [{ key: 'synced', label: 'Items synced' }],
  history: [
    { key: 'synced', label: 'Transfers' },
    { key: 'soldMarked', label: 'Marked sold' },
    { key: 'enriched', label: 'Enriched' },
    { key: 'claimed', label: 'Claimed' },
  ],
}

const sync = useSyncStore()

// The store keeps its own status slice per kind; a shared "is busy" flag would let
// a history backfill disable the marketplace buttons, and the cron runs both kinds
// every minute regardless of what this page is doing.
const byKind = computed(() => ({
  marketplace: sync.forKind('marketplace'),
  history: sync.forKind('history'),
}))

// Set when the server reports it joined a run rather than starting one, so a click
// that did nothing is not left looking like a click that did.
const deduped = ref<Record<SyncKind, boolean>>({ marketplace: false, history: false })

function statsFor(kind: SyncKind): { key: string; label: string; value: number | null }[] {
  return KIND_STATS[kind].map((s) => ({ ...s, value: statOf(byKind.value[kind], s.key) }))
}

function finishedLabel(status: SyncKindStatus): string {
  if (status.running) return 'Running now'
  if (!status.lastFinishedAt) return '—'
  return formatDateTime(status.lastFinishedAt)
}

function buttonLabel(mode: string): string {
  return mode === 'latest' ? 'Sync Latest' : 'Sync All'
}

/**
 * Disabled while this kind is busy. The cron fires a run every minute, so this
 * flickers for a few seconds each minute — which is honest, since pressing it
 * during that window would only join the run already in progress.
 */
function isBusy(kind: SyncKind): boolean {
  return sync.loading || byKind.value[kind].running
}

function spinning(kind: SyncKind, mode: string): boolean {
  const status = byKind.value[kind]
  return status.running && status.mode === mode
}

async function trigger(kind: SyncKind, mode: 'latest' | 'all' | 'full'): Promise<void> {
  deduped.value[kind] = false
  try {
    // No options to thread through. The server still accepts `itemName`, but a
    // backfill now walks to the upstream's natural end, so there is nothing left
    // to bound it with.
    const res = await sync.enqueue({ kind, mode })
    deduped.value[kind] = res.deduped
  } catch {
    // The store surfaces this in `error`, which the alert at the top renders.
  }
}

// Which kind the confirm dialog is open for; null when it is closed. Doubles as
// the "a clear is in flight" marker for that card's button.
const clearing = ref<SyncKind | null>(null)
const clearingNow = ref(false)
// What the last clear actually removed, so the dialog reports a number instead
// of implying success with no evidence.
const cleared = ref<ClearSyncDataResult | null>(null)

function askClear(kind: SyncKind) {
  deduped.value[kind] = false
  cleared.value = null
  clearing.value = kind
}

/** Dismissed by Cancel or by clicking out — never by a successful clear. */
function onDialogChange(open: boolean) {
  if (!open && !clearingNow.value) clearing.value = null
}

async function confirmClear(): Promise<void> {
  const kind = clearing.value
  if (!kind || clearingNow.value) return
  clearingNow.value = true
  try {
    cleared.value = await sync.clear(kind)
  } catch {
    // Rendered by the alert at the top; leave the dialog open to retry or cancel.
  } finally {
    clearingNow.value = false
  }
}

function clearedSummary(res: ClearSyncDataResult | null): string {
  if (!res) return ''
  const d = res.deleted as Record<string, number>
  const parts = Object.entries(d).map(([k, v]) => `${v} ${k}`)
  return `Deleted ${parts.join(' and ')}.`
}

onMounted(() => {
  // The store polls the status endpoint on its own while any run is in flight, so
  // this page needs no timer of its own — and nothing to clean up on unmount.
  void sync.start()
})
</script>
