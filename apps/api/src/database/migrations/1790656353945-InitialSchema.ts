import { MigrationInterface, QueryRunner } from "typeorm";

export class InitialSchema1790656353945 implements MigrationInterface {
    name = 'InitialSchema1790656353945'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "marketplace_item_detail" ("item_id" integer NOT NULL, "attributes" jsonb, "datas" jsonb, "infos" jsonb, CONSTRAINT "PK_62098a83a9594784fd984404f34" PRIMARY KEY ("item_id"))`);
        await queryRunner.query(`CREATE TABLE "marketplace_items" ("id" integer NOT NULL, "token_id" integer NOT NULL, "seller_id" text NOT NULL, "seller_name" text, "image_url" text NOT NULL, "name" text NOT NULL, "currency" text NOT NULL DEFAULT 'NUMI', "price" double precision NOT NULL, "grade_effect" text NOT NULL, "level" integer NOT NULL, "enchant" integer NOT NULL, "equipment_type" text NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL, "mint_time" TIMESTAMP WITH TIME ZONE, "sold" boolean NOT NULL DEFAULT false, CONSTRAINT "PK_938c61f94576194233d3f318501" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_3f8a2d74e216b10ca1daeb3002" ON "marketplace_items" ("token_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_79de7415f71cc395a1b623778b" ON "marketplace_items" ("grade_effect") `);
        await queryRunner.query(`CREATE INDEX "IDX_3a77c57f68f4f443b0d0ca6198" ON "marketplace_items" ("equipment_type") `);
        await queryRunner.query(`CREATE TABLE "marketplace_favorites" ("id" SERIAL NOT NULL, "name" text NOT NULL, "q" text, "equipment_types" jsonb, "grade_effects" jsonb, "sort" text NOT NULL DEFAULT 'recent', "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_9d9f73762bc52ac5b6f1021e696" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_8321a0f29001640e8af72236b6" ON "marketplace_favorites" ("name") `);
        await queryRunner.query(`CREATE TABLE "users" ("id" text NOT NULL, "username" text, CONSTRAINT "PK_a3ffb1c0c8416b9fc6f907b7433" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "marketplace_token_transfers" ("id" SERIAL NOT NULL, "token_id" integer NOT NULL, "game_name" text, "seller_id" text NOT NULL, "buyer_id" text NOT NULL, "item_name" text NOT NULL, "price" double precision NOT NULL, "currency" text NOT NULL DEFAULT 'NUMI', "tx_hash" text NOT NULL, "image_url" text, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL, "claimed" boolean NOT NULL DEFAULT false, CONSTRAINT "PK_7ad918eadce9b23ed7c849f61fb" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_798fa56b3fae30cc3acfa840ec" ON "marketplace_token_transfers" ("token_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_4556927f0967415e1a4217fd40" ON "marketplace_token_transfers" ("game_name") `);
        await queryRunner.query(`CREATE INDEX "IDX_d473c158191da9279af889dc79" ON "marketplace_token_transfers" ("seller_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_5b9c17002f7d6ef3a3a6207b95" ON "marketplace_token_transfers" ("buyer_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_e530f06a8d2256cf44b68c12f2" ON "marketplace_token_transfers" ("item_name") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_337269509f7efe0cefdc14c72b" ON "marketplace_token_transfers" ("tx_hash") `);
        await queryRunner.query(`CREATE INDEX "IDX_7237f0aae4faf6c878264f0534" ON "marketplace_token_transfers" ("created_at") `);
        await queryRunner.query(`CREATE INDEX "IDX_c491155318599153d5ce470a0b" ON "marketplace_token_transfers" ("claimed") `);
        await queryRunner.query(`ALTER TABLE "marketplace_item_detail" ADD CONSTRAINT "FK_62098a83a9594784fd984404f34" FOREIGN KEY ("item_id") REFERENCES "marketplace_items"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "marketplace_item_detail" DROP CONSTRAINT "FK_62098a83a9594784fd984404f34"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_c491155318599153d5ce470a0b"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_7237f0aae4faf6c878264f0534"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_337269509f7efe0cefdc14c72b"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_e530f06a8d2256cf44b68c12f2"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_5b9c17002f7d6ef3a3a6207b95"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_d473c158191da9279af889dc79"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_4556927f0967415e1a4217fd40"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_798fa56b3fae30cc3acfa840ec"`);
        await queryRunner.query(`DROP TABLE "marketplace_token_transfers"`);
        await queryRunner.query(`DROP TABLE "users"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_8321a0f29001640e8af72236b6"`);
        await queryRunner.query(`DROP TABLE "marketplace_favorites"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_3a77c57f68f4f443b0d0ca6198"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_79de7415f71cc395a1b623778b"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_3f8a2d74e216b10ca1daeb3002"`);
        await queryRunner.query(`DROP TABLE "marketplace_items"`);
        await queryRunner.query(`DROP TABLE "marketplace_item_detail"`);
    }

}
