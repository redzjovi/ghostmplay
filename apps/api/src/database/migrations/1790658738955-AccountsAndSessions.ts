import { MigrationInterface, QueryRunner } from "typeorm";

export class AccountsAndSessions1790658738955 implements MigrationInterface {
    name = 'AccountsAndSessions1790658738955'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_8321a0f29001640e8af72236b6"`);
        await queryRunner.query(`CREATE TABLE "accounts" ("id" SERIAL NOT NULL, "username" citext NOT NULL, "password_hash" text NOT NULL, "role" text NOT NULL DEFAULT 'user', "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_5a7a02c20412299d198e097a8fe" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_477e3187cedfb5a3ac121e899c" ON "accounts" ("username") `);
        await queryRunner.query(`CREATE TABLE "sessions" ("id" BIGSERIAL NOT NULL, "account_id" integer NOT NULL, "token_hash" text NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "PK_3238ef96f18b355b671619111bc" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_da0cf19646ff5c6e3c0284468e" ON "sessions" ("account_id") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_abaa9e068cdd390bc5210f7988" ON "sessions" ("token_hash") `);
        await queryRunner.query(`CREATE INDEX "IDX_476aa19b1412e9872ef8f89e87" ON "sessions" ("created_at") `);
        await queryRunner.query(`CREATE INDEX "IDX_9cfe37d28c3b229a350e086d94" ON "sessions" ("expires_at") `);
        await queryRunner.query(`ALTER TABLE "marketplace_favorites" ADD "account_id" integer`);
        // Favorites created before accounts existed have no owner and cannot be
        // meaningfully attributed to one, so they are discarded rather than
        // silently attached to an arbitrary account.
        await queryRunner.query(`DELETE FROM "marketplace_favorites" WHERE "account_id" IS NULL`);
        await queryRunner.query(`ALTER TABLE "marketplace_favorites" ALTER COLUMN "account_id" SET NOT NULL`);
        await queryRunner.query(`CREATE INDEX "IDX_d41cb1c2c402dbd633b6749430" ON "marketplace_favorites" ("account_id") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "UQ_favorites_account_name" ON "marketplace_favorites" ("account_id", "name") `);
        await queryRunner.query(`ALTER TABLE "sessions" ADD CONSTRAINT "FK_da0cf19646ff5c6e3c0284468e5" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "sessions" DROP CONSTRAINT "FK_da0cf19646ff5c6e3c0284468e5"`);
        await queryRunner.query(`DROP INDEX "public"."UQ_favorites_account_name"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_d41cb1c2c402dbd633b6749430"`);
        await queryRunner.query(`ALTER TABLE "marketplace_favorites" DROP COLUMN "account_id"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_9cfe37d28c3b229a350e086d94"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_476aa19b1412e9872ef8f89e87"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_abaa9e068cdd390bc5210f7988"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_da0cf19646ff5c6e3c0284468e"`);
        await queryRunner.query(`DROP TABLE "sessions"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_477e3187cedfb5a3ac121e899c"`);
        await queryRunner.query(`DROP TABLE "accounts"`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_8321a0f29001640e8af72236b6" ON "marketplace_favorites" ("name") `);
    }

}
