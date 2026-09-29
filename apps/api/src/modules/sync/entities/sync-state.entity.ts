import { Entity, PrimaryColumn, Column } from 'typeorm'

export type SyncKind = 'marketplace' | 'history'

/** marketplace scrapes the item list; history scrapes the transaction log. */
export type SyncMode = 'latest' | 'all' | 'full'

/**
 * Terminal and in-flight outcomes. There is no "queued": sync is serialised by a
 * lock rather than a queue, so a request either starts running or is deduplicated
 * into the run already happening.
 */
export type SyncStatus = 'running' | 'done' | 'failed' | 'interrupted'

/** Both kinds the app knows about, in the order the scheduler visits them. */
export const SYNC_KINDS = ['marketplace', 'history'] as const

/**
 * Current sync state for one kind — at most one row per kind, forever.
 *
 * This replaced an append-only `sync_jobs` table. The upstream API is public and
 * unauthenticated, so syncing is by far the most expensive thing this app does,
 * and the only questions the UI ever asked were "is it running?" and "when did it
 * last finish, and how much did it get?". Both are answered by one mutable row, so
 * a table that grew ~2,880 rows a day at the intended cron cadence held no
 * information the row does not hold, and had to be pruned.
 *
 * `running_since` is the lock, made durable: it survives a process restart long
 * enough for boot recovery to notice and mark the run interrupted.
 */
@Entity('sync_state')
export class SyncStateEntity {
  @PrimaryColumn({ type: 'text' }) kind!: SyncKind

  /** Mode of the most recent run, so the UI can label a stale-but-running scrape. */
  @Column({ type: 'text', default: 'latest' }) mode!: SyncMode

  /** Non-null exactly while a run holds the lock. Cleared on completion. */
  @Column({ type: 'timestamptz', nullable: true, name: 'running_since' }) runningSince!: Date | null

  @Column({ type: 'timestamptz', nullable: true, name: 'last_started_at' }) lastStartedAt!: Date | null

  @Column({ type: 'timestamptz', nullable: true, name: 'last_finished_at' }) lastFinishedAt!: Date | null

  @Column({ type: 'text', nullable: true, name: 'last_status' }) lastStatus!: SyncStatus | null

  @Column({ type: 'jsonb', nullable: true, name: 'last_stats' }) lastStats!: Record<string, unknown> | null

  @Column({ type: 'text', nullable: true, name: 'last_error' }) lastError!: string | null
}
