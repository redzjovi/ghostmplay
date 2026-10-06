import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * External identities (currently Google only) plus the nullable credentials a
 * provider-only account does not have.
 *
 * Note on what TypeORM's generator produced here: it also emitted a DROP of
 * `idx_items_active_sold_at` and a plain `CREATE INDEX ... (created_at)` in down().
 * That index is a deliberate *partial* index from the SoldAt migration —
 * `(created_at DESC) WHERE sold_at IS NULL` — and every browse query filters and
 * sorts on exactly that. TypeORM cannot see it because partial indexes are not
 * representable in entity metadata, so it reads it as drift. Recreating it without
 * the predicate or the sort direction would leave every list query doing a sort it
 * was previously served by an index, so both statements are dropped and the index
 * is left alone.
 */
export class GoogleIdentities1790854290511 implements MigrationInterface {
  name = 'GoogleIdentities1790854290511'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE "account_identities" ("id" SERIAL NOT NULL, "account_id" integer NOT NULL, "provider" text NOT NULL, "provider_subject" text NOT NULL, "email" citext, "picture_url" text, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_03a85f9b5b43e86ca9d6f5ec0f7" PRIMARY KEY ("id"))`);
    await queryRunner.query(`CREATE INDEX "IDX_df2ef81da2fbf39fac6344a199" ON "account_identities" ("account_id") `);

    // One account per external identity. Email is deliberately not part of this key:
    // it is not something an account owner controls, so keying on it would let
    // anyone who can register an address resembling someone else's claim their
    // account. Google's `sub` is stable and never reassigned.
    await queryRunner.query(`CREATE UNIQUE INDEX "UQ_identity_provider_subject" ON "account_identities" ("provider", "provider_subject") `);

    // A Google-only account has no username and no local credential. The existing
    // unique citext index on username survives: Postgres permits many NULLs.
    await queryRunner.query(`ALTER TABLE "accounts" ALTER COLUMN "username" DROP NOT NULL`);
    await queryRunner.query(`ALTER TABLE "accounts" ALTER COLUMN "password_hash" DROP NOT NULL`);

    // CASCADE, so deleting an account takes its identities with it. Favorites are
    // left as they are: they already reference account_id without a constraint.
    await queryRunner.query(`ALTER TABLE "account_identities" ADD CONSTRAINT "FK_df2ef81da2fbf39fac6344a199e" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "account_identities" DROP CONSTRAINT "FK_df2ef81da2fbf39fac6344a199e"`);

    // Reinstating NOT NULL only works while no provider-only account exists, so
    // those rows are removed first rather than failing the whole rollback.
    await queryRunner.query(`DELETE FROM "accounts" WHERE "username" IS NULL OR "password_hash" IS NULL`);

    await queryRunner.query(`ALTER TABLE "accounts" ALTER COLUMN "password_hash" SET NOT NULL`);
    await queryRunner.query(`ALTER TABLE "accounts" ALTER COLUMN "username" SET NOT NULL`);
    await queryRunner.query(`DROP INDEX "public"."UQ_identity_provider_subject"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_df2ef81da2fbf39fac6344a199"`);
    await queryRunner.query(`DROP TABLE "account_identities"`);
  }
}
