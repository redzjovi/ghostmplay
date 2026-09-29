import { MigrationInterface, QueryRunner } from "typeorm";

export class SyncState1790683200000 implements MigrationInterface {
    name = 'SyncState1790683200000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "sync_state" ("kind" text NOT NULL, "mode" text NOT NULL DEFAULT 'latest', "running_since" TIMESTAMP WITH TIME ZONE, "last_started_at" TIMESTAMP WITH TIME ZONE, "last_finished_at" TIMESTAMP WITH TIME ZONE, "last_status" text, "last_stats" jsonb, "last_error" text, CONSTRAINT "PK_sync_state_kind" PRIMARY KEY ("kind"))`);

        // Carry the newest completed run per kind across, so an existing deployment
        // keeps its "last synced" label instead of resetting to "never". DISTINCT ON
        // with a matching ORDER BY is the idiomatic "latest row per group" in
        // PostgreSQL. NULLS LAST keeps a run that never finished from winning over
        // one that did.
        await queryRunner.query(`
            INSERT INTO "sync_state" ("kind", "mode", "last_started_at", "last_finished_at", "last_status", "last_stats", "last_error")
            SELECT DISTINCT ON (kind) kind, mode, started_at, finished_at, 'done', stats, NULL
            FROM "sync_jobs"
            WHERE status = 'done'
            ORDER BY kind, finished_at DESC NULLS LAST
        `);

        // A kind that has never completed a run still needs a row: the UI reads one
        // row per kind, and the orchestrator upserts rather than inserts.
        await queryRunner.query(`
            INSERT INTO "sync_state" ("kind", "mode")
            VALUES ('marketplace', 'latest'), ('history', 'latest')
            ON CONFLICT ("kind") DO NOTHING
        `);

        // The `kind` and `status` indexes go with the table; the primary key on
        // `kind` already covers lookups by kind, which is the only access pattern
        // that survives the collapse.
        await queryRunner.query(`DROP INDEX "public"."IDX_70597b4533496985f96871a14b"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_43fd25445c703b5e6f75393b17"`);
        await queryRunner.query(`DROP TABLE "sync_jobs"`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "sync_jobs" ("id" SERIAL NOT NULL, "kind" text NOT NULL, "status" text NOT NULL DEFAULT 'queued', "trigger" text NOT NULL DEFAULT 'cron', "account_id" integer, "mode" text NOT NULL, "item_name" text, "max_pages" integer NOT NULL DEFAULT '200', "stats" jsonb, "error" text, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "started_at" TIMESTAMP WITH TIME ZONE, "finished_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_8586b15058c8811de6286052139" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_43fd25445c703b5e6f75393b17" ON "sync_jobs" ("kind") `);
        await queryRunner.query(`CREATE INDEX "IDX_70597b4533496985f96871a14b" ON "sync_jobs" ("status") `);

        // Re-expand the two state rows into one finished job each. History is not
        // restorable — a collapsed table has forgotten every intermediate run — but
        // the latest outcome per kind is enough for the UI to render correctly.
        await queryRunner.query(`
            INSERT INTO "sync_jobs" ("kind", "status", "trigger", "mode", "stats", "error", "created_at", "started_at", "finished_at")
            SELECT kind,
                   COALESCE(last_status, 'interrupted'),
                   'cron',
                   mode,
                   last_stats,
                   last_error,
                   COALESCE(last_finished_at, last_started_at, now()),
                   last_started_at,
                   last_finished_at
            FROM "sync_state"
            WHERE last_finished_at IS NOT NULL OR last_started_at IS NOT NULL
        `);

        await queryRunner.query(`DROP TABLE "sync_state"`);
    }

}
