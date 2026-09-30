import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Repairs transfer timestamps that were stored 9 hours ahead of the truth.
 *
 * `parseTransferTime` used to treat the transfer log's bare "YYYY-MM-DD HH:mm:ss"
 * as UTC by appending `Z`. It is KST — the same +09:00 that `item-detail` spells
 * out in `mintTime` — so every stored transfer was 9 hours late. That put some of
 * them in the future, and skewed the sold-state join that compares a transfer
 * against its listing's own `created_at`.
 *
 * The code fix ships in the same deploy, and migrations run at boot before the
 * cron can write anything, so the rows this touches are exactly the ones the old
 * parser produced. Rows written by the fixed parser are correct and must not move.
 */
export class FixTransferTimezone1790812800000 implements MigrationInterface {
    name = 'FixTransferTimezone1790812800000'

    /** The offset the log's timestamps are actually in. Korea has no DST. */
    private readonly KST_OFFSET_HOURS = 9;

    public async up(queryRunner: QueryRunner): Promise<void> {
        // A completed transfer cannot be dated in the future, so one that is proves
        // the parser was wrong — which is also the only case where shifting is
        // correct. On a database that never stored a bad row this is a no-op, so
        // there is no need to know whether the deploy predates the fix.
        const probe = await queryRunner.query(
            `SELECT EXISTS (SELECT 1 FROM "marketplace_token_transfers" WHERE "created_at" > now()) AS skewed`
        );
        if (!(probe?.[0]?.skewed === true || probe?.[0]?.skewed === 't')) return;

        // One shift for every row, not just the future-dated ones: a transfer from
        // earlier the same day also sits 9 hours ahead while still reading as past.
        await queryRunner.query(
            `UPDATE "marketplace_token_transfers" SET "created_at" = "created_at" - interval '${this.KST_OFFSET_HOURS} hours'`
        );

        // Those marks were derived from the skewed timestamps, so some are missed
        // and some are false. Cleared rather than adjusted, because the next history
        // run re-derives all of it from the corrected ledger via markItemsSold.
        await queryRunner.query(
            `UPDATE "marketplace_items" SET "sold_at" = NULL, "sold_price" = NULL WHERE "sold_at" IS NOT NULL`
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Undo the shift only. The cleared sold marks are not restored, because the
        // values they replace were computed from the skewed data in the first place.
        await queryRunner.query(
            `UPDATE "marketplace_token_transfers" SET "created_at" = "created_at" + interval '${this.KST_OFFSET_HOURS} hours'`
        );
    }

}
