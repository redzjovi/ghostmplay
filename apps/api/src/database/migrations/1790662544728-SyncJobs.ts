import { MigrationInterface, QueryRunner } from "typeorm";

export class SyncJobs1790662544728 implements MigrationInterface {
    name = 'SyncJobs1790662544728'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "sync_jobs" ("id" SERIAL NOT NULL, "kind" text NOT NULL, "status" text NOT NULL DEFAULT 'queued', "trigger" text NOT NULL DEFAULT 'cron', "account_id" integer, "mode" text NOT NULL, "item_name" text, "max_pages" integer NOT NULL DEFAULT '200', "stats" jsonb, "error" text, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "started_at" TIMESTAMP WITH TIME ZONE, "finished_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_8586b15058c8811de6286052139" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_43fd25445c703b5e6f75393b17" ON "sync_jobs" ("kind") `);
        await queryRunner.query(`CREATE INDEX "IDX_70597b4533496985f96871a14b" ON "sync_jobs" ("status") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_70597b4533496985f96871a14b"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_43fd25445c703b5e6f75393b17"`);
        await queryRunner.query(`DROP TABLE "sync_jobs"`);
    }

}
