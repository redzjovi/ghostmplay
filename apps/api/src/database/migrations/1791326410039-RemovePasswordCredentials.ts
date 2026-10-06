import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * Removes the password credential from `accounts`.
 *
 * Sign-in is Google-only now: the login and register endpoints, the argon2 hashing,
 * the ADMIN_USERNAME / ADMIN_PASSWORD bootstrap and the username column are all gone.
 * What is left on an account is `id` and `role`.
 *
 * `password_hash` was the only place a password lived and `username` its only
 * identifier; neither is read by anything anymore, so both go. The unique index on
 * `username` goes with the column it constrains.
 *
 * Hand-written rather than generated — `migration:generate` executes the migration it
 * writes, and it also reads TypeORM-unrepresentable objects such as the partial index
 * `idx_items_active_sold_at` as drift and drops them.
 *
 * The citext extension stays: `account_identities.email` still uses it.
 */
export class RemovePasswordCredentials1791326410039 implements MigrationInterface {
  name = 'RemovePasswordCredentials1791326410039'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."IDX_477e3187cedfb5a3ac121e899c"`);
    await queryRunner.query(`ALTER TABLE "accounts" DROP COLUMN "username"`);
    await queryRunner.query(`ALTER TABLE "accounts" DROP COLUMN "password_hash"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Nullable, unlike the original NOT NULL. Reinstating NOT NULL would fail against
    // any account created by Google sign-in, so a rollback trades that constraint for
    // a rollback that actually completes — see the column comments in account.entity.
    await queryRunner.query(`ALTER TABLE "accounts" ADD "username" citext`);
    await queryRunner.query(`ALTER TABLE "accounts" ADD "password_hash" text`);
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_477e3187cedfb5a3ac121e899c" ON "accounts" ("username") `);
  }
}
