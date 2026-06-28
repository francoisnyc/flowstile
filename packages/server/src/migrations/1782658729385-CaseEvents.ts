import { MigrationInterface, QueryRunner } from "typeorm";

export class CaseEvents1782658729385 implements MigrationInterface {
    name = 'CaseEvents1782658729385'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TYPE "public"."case_events_actor_enum" AS ENUM('human', 'system', 'agent')`);
        await queryRunner.query(`CREATE TABLE "case_events" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "caseId" uuid NOT NULL, "actor" "public"."case_events_actor_enum" NOT NULL, "label" character varying NOT NULL, "payload" jsonb, "phase" character varying, "recordedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_61f203ee26b76c6438bbcc7bde6" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "idx_case_event_case_id" ON "case_events" ("caseId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."idx_case_event_case_id"`);
        await queryRunner.query(`DROP TABLE "case_events"`);
        await queryRunner.query(`DROP TYPE "public"."case_events_actor_enum"`);
    }

}
