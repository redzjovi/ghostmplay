import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * Expression and trigram indexes that TypeORM's decorator metadata cannot express.
 *
 * 1. history.service.ts joins users on `su.id = LOWER(t.sellerId)`. The plain
 *    b-tree index on `seller_id` does not help — the indexed expression is `id`,
 *    the searched one is `LOWER(seller_id)`, so the join is unsargable and falls
 *    back to a nested loop over every transfer row.
 * 2. Both list endpoints filter with `LOWER(col) LIKE '%term%'`, which cannot use a
 *    ordinary b-tree. pg_trgm turns the leading-wildcard scan into an index lookup.
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
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_items_name_trgm" ON "marketplace_items" USING gin (lower("name") gin_trgm_ops)`
    )
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_transfers_item_name_trgm" ON "marketplace_token_transfers" USING gin (lower("item_name") gin_trgm_ops)`
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_transfers_item_name_trgm"`)
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_items_name_trgm"`)
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_transfers_buyer_lower"`)
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_transfers_seller_lower"`)
  }
}
