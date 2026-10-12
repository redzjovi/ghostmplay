import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * Expression indexes that TypeORM's decorator metadata cannot express.
 *
 * `history.service.ts` joins `users` on `su.id = LOWER(t.seller_id)`. The plain
 * b-tree index on `seller_id` does not help here — the indexed expression is
 * `id`, the searched one is `LOWER(seller_id)`, so the join is unsargable and
 * falls back to a nested loop over every transfer row. These two fix that.
 *
 * What is deliberately NOT here: a trigram index on the searchable name columns.
 * Those list endpoints filter with `LOWER(col) LIKE '%term%'`, which cannot use an
 * ordinary b-tree, so the columns once carried GIN + `gin_trgm_ops` indexes. They
 * were never chosen by the planner at this table size — scanning a few hundred
 * rows beats consulting an index, and a full history backfill brings this table to
 * roughly 13,000 rows, where a sequential scan is still single-digit milliseconds.
 *
 * That mattered beyond tidiness: `gin_trgm_ops` needs the `pg_trgm` extension, and
 * `CREATE EXTENSION` meant a shared-hosting account without permission to install
 * it could not run migrations at all. An optimisation nobody was paying for was
 * blocking every deployment. Revisit past ~100k rows, where a trigram index earns
 * its extension request.
 */
export class SearchIndexes1790656354000 implements MigrationInterface {
  name = 'SearchIndexes1790656354000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_transfers_seller_lower" ON "marketplace_token_transfers" (lower("seller_id"))`
    )
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_transfers_buyer_lower" ON "marketplace_token_transfers" (lower("buyer_id"))`
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_transfers_buyer_lower"`)
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_transfers_seller_lower"`)
  }
}