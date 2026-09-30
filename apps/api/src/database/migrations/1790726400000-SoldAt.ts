import { MigrationInterface, QueryRunner } from "typeorm";

export class SoldAt1790726400000 implements MigrationInterface {
    name = 'SoldAt1790726400000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "marketplace_items" ADD COLUMN "sold_at" TIMESTAMP WITH TIME ZONE`);
        await queryRunner.query(`ALTER TABLE "marketplace_items" ADD COLUMN "sold_price" double precision`);

        // sold_at is derived from the transfer ledger and from nothing else.
        //
        // The old `sold` boolean was set by the marketplace scraper inferring
        // "a detail fetch returned nothing, so it must be sold" — and that fetch
        // swallowed every error, so a 5xx, a 429 or a DNS blip was recorded as a
        // sale. Those false positives are not carried over: the transfers table
        // is the only authority, and re-deriving from it is what corrects them.
        //
        // `price > 0` skips non-sale movements (mints, zero-value hand-offs).
        // DISTINCT ON picks the most recent transfer per token, which is the
        // sale that ended the listing.
        //
        // The temporal guard keeps a relist honest: a token that sold and came
        // back as a new listing shares its token_id with the old one, so without
        // it the previous sale would immediately re-sell the new listing. It also
        // makes the result self-consistent — sold_at can never predate created_at.
        await queryRunner.query(`
            UPDATE "marketplace_items" i
            SET "sold_at" = t."created_at", "sold_price" = t."price"
            FROM (
                SELECT DISTINCT ON ("token_id") "token_id", "price", "created_at"
                FROM "marketplace_token_transfers"
                WHERE "price" > 0
                ORDER BY "token_id", "created_at" DESC
            ) t
            WHERE i."token_id" = t."token_id"
              AND i."sold_at" IS NULL
              AND t."created_at" >= i."created_at"
        `);

        // Only now that the values live in sold_at is the boolean redundant. The
        // NOT NULL default matters for down(): a pre-existing row that predates
        // the column must not read as sold.
        await queryRunner.query(`ALTER TABLE "marketplace_items" DROP COLUMN "sold"`);

        // Partial, because every browse query filters on `sold_at IS NULL`. An
        // index that only contains live listings is both smaller and cheaper to
        // scan, and it matches the predicate exactly so the planner can use it.
        await queryRunner.query(`CREATE INDEX "idx_items_active_sold_at" ON "marketplace_items" ("created_at" DESC) WHERE "sold_at" IS NULL`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."idx_items_active_sold_at"`);

        await queryRunner.query(`ALTER TABLE "marketplace_items" ADD COLUMN "sold" boolean NOT NULL DEFAULT false`);
        // Derivable in the other direction, so unlike the original `sold` this
        // reverts cleanly: any timestamp means sold.
        await queryRunner.query(`UPDATE "marketplace_items" SET "sold" = true WHERE "sold_at" IS NOT NULL`);

        await queryRunner.query(`ALTER TABLE "marketplace_items" DROP COLUMN "sold_price"`);
        await queryRunner.query(`ALTER TABLE "marketplace_items" DROP COLUMN "sold_at"`);
    }

}
