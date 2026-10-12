import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * Removes the last two objects that needed `pg_trgm` and `citext`.
 *
 * Both extensions were dropped from the migrations that created them, but a
 * migration TypeORM has already executed is never re-run, so a database created
 * before that change still carries the trigram indexes and a `citext` column.
 * This converges it on the shape a fresh database now gets.
 *
 * Every statement is idempotent, so this is equally safe on a database that was
 * never created with the extensions — which is the common case on a shared host,
 * where a missing index or an already-plain column changes nothing.
 *
 * What is left behind on purpose: the extensions themselves, if they are
 * installed. `DROP EXTENSION` would fail on a database where something else
 * depends on them, and nothing here needs them gone — the requirement being
 * removed is the privilege to *create* them.
 *
 * The `email` cast matters more than it looks: `citext` is not assignment
 * compatible with `varchar` in every direction, and the entity declares
 * `varchar(255)`. The cast refuses to truncate, so a stored address longer than
 * 255 characters fails the migration naming the row instead of being silently
 * shortened — and since RFC 5321 caps an address at 254 characters, a failure
 * here means the column does not hold what it claims to.
 */
export class DropExtensionDependencies1791795268673 implements MigrationInterface {
  name = 'DropExtensionDependencies1791795268673'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_items_name_trgm"`)
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_transfers_item_name_trgm"`)
    await queryRunner.query(
      `ALTER TABLE "account_identities" ALTER COLUMN "email" TYPE varchar(255) USING "email"::varchar(255)`
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Intentionally empty. Restoring the trigram indexes or the `citext` column
    // would re-require exactly the privileges this migration exists to stop
    // needing, and a rollback that fails on a shared host is worse than one that
    // does not attempt to undo an optimisation nothing was using.
  }
}