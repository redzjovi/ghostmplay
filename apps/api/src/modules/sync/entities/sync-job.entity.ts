import { Entity, PrimaryGeneratedColumn, Column, Index, CreateDateColumn } from 'typeorm'

export type SyncJobKind = 'marketplace' | 'history'
export type SyncJobStatus = 'queued' | 'running' | 'done' | 'failed' | 'interrupted'
export type SyncJobTrigger = 'cron' | 'admin'

/**
 * A single unit of scraper work. The upstream API is public and unauthenticated,
 * so syncing is the most expensive thing this app does by far: it is queued,
 * serialised by a lock, and reported through a status row rather than held open
 * over an HTTP request.
 */
@Entity('sync_jobs')
export class SyncJobEntity {
  @PrimaryGeneratedColumn({ type: 'integer' }) id!: number

  @Index()
  @Column({ type: 'text' }) kind!: SyncJobKind

  @Index()
  @Column({ type: 'text', default: 'queued' }) status!: SyncJobStatus

  @Column({ type: 'text', default: 'cron' }) trigger!: SyncJobTrigger

  /** Who asked for it, for admin-triggered jobs. Null for cron. */
  @Column({ type: 'integer', nullable: true, name: 'account_id' }) accountId!: number | null

  @Column({ type: 'text' }) mode!: string

  @Column({ type: 'text', nullable: true, name: 'item_name' }) itemName!: string | null

  /** Safety valve for backfills. A full scan of the upstream API is unbounded. */
  @Column({ type: 'integer', default: 200, name: 'max_pages' }) maxPages!: number

  @Column({ type: 'jsonb', nullable: true }) stats!: Record<string, unknown> | null

  @Column({ type: 'text', nullable: true }) error!: string | null

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' }) createdAt!: Date

  @Column({ type: 'timestamptz', nullable: true, name: 'started_at' }) startedAt!: Date | null

  @Column({ type: 'timestamptz', nullable: true, name: 'finished_at' }) finishedAt!: Date | null
}
