import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * Extensions that must exist before the trigram indexes in SearchIndexes can be created.
 * Both are on DOM Cloud's supported extension list.
 *
 * Kept as its own migration so a permissions failure here is isolated and obvious
 * rather than blocking the base schema.
 */
export class Extensions1767225600000 implements MigrationInterface {
  name = 'Extensions1767225600000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "pg_trgm"`)
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "citext"`)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Left in place on purpose: dropping these would break SearchIndexes.
  }
}
