import { MigrationInterface, QueryRunner } from "typeorm";

export class InlineForms1782744000000 implements MigrationInterface {
    name = 'InlineForms1782744000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        // Ad-hoc tasks carry an inline form and have no task definition / locked
        // form version, so both columns become nullable.
        await queryRunner.query(`ALTER TABLE "tasks" ALTER COLUMN "task_definition_id" DROP NOT NULL`);
        await queryRunner.query(`ALTER TABLE "tasks" ALTER COLUMN "formDefinitionVersion" DROP NOT NULL`);
        await queryRunner.query(`ALTER TABLE "tasks" ADD "name" character varying`);
        await queryRunner.query(`ALTER TABLE "tasks" ADD "inlineFormSchema" jsonb`);
        await queryRunner.query(`ALTER TABLE "tasks" ADD "inlineUiSchema" jsonb`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "tasks" DROP COLUMN "inlineUiSchema"`);
        await queryRunner.query(`ALTER TABLE "tasks" DROP COLUMN "inlineFormSchema"`);
        await queryRunner.query(`ALTER TABLE "tasks" DROP COLUMN "name"`);
        // These reverses assume no ad-hoc rows (NULLs) remain; the down path is
        // for clean rollback of a freshly-applied migration.
        await queryRunner.query(`ALTER TABLE "tasks" ALTER COLUMN "formDefinitionVersion" SET NOT NULL`);
        await queryRunner.query(`ALTER TABLE "tasks" ALTER COLUMN "task_definition_id" SET NOT NULL`);
    }

}
