import { Injectable } from '@nestjs/common'

export interface Lock {
  release(): Promise<void>
}

/**
 * In-process mutex, one lock per key.
 *
 * Scraping the upstream API is the most expensive thing this app does, and a
 * second scrape of the same kind would double that cost against a public endpoint
 * that answers to everybody. This is the only thing standing between "Sync full"
 * and a second full backfill, so `acquire` refusing while a key is held is the
 * whole contract: the caller reports "already running" instead of starting work.
 *
 * **It is per process, and the deployment depends on that.** cPanel's Passenger
 * spawns the app, and `PassengerMinInstances` / `PassengerMaxInstances` are pinned
 * to 1 so exactly one instance exists (docs/DEPLOY-CPANEL.md). If that pin is ever
 * lost — a host overriding the .htaccess, or a second app pointing at the same
 * database — two processes each get their own set, both scrape, and `clear()` can
 * delete rows out from under the other process's inserts. Nothing here detects that.
 *
 * The keys never expire, which is the point: the lock is released in a `finally`
 * and, if that never runs, the process that died took the lock with it. That is
 * why there is no TTL, no renewal timer and no boot-time cleanup — a lock cannot
 * outlive the process that took it, so there is nothing left behind to clear.
 *
 * `release` only frees the key while this holder still owns it, so a caller that
 * releases twice cannot break the run that took the lock in between.
 *
 * Both methods stay promise-shaped because every caller awaits them, including
 * `release()` inside a `finally` where a rejection would otherwise be unhandled.
 */
@Injectable()
export class LockService {
  private readonly held = new Map<string, symbol>()

  async acquire(key: string): Promise<Lock | null> {
    if (this.held.has(key)) return null
    const token = Symbol(key)
    this.held.set(key, token)
    return {
      release: async () => {
        if (this.held.get(key) === token) this.held.delete(key)
      },
    }
  }
}