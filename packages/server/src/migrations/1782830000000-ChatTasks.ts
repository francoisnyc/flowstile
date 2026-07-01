import { MigrationInterface, QueryRunner } from "typeorm";

export class ChatTasks1782830000000 implements MigrationInterface {
    name = 'ChatTasks1782830000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        // Chat config on the task (agent, goal, greeting).
        await queryRunner.query(`ALTER TABLE "tasks" ADD "chat" jsonb`);

        // The conversation transcript.
        await queryRunner.query(`CREATE TYPE "public"."task_messages_role_enum" AS ENUM('human', 'agent')`);
        await queryRunner.query(`CREATE TABLE "task_messages" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "taskId" uuid NOT NULL, "role" "public"."task_messages_role_enum" NOT NULL, "content" text NOT NULL, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_task_messages_id" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "idx_task_message_task_id" ON "task_messages" ("taskId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."idx_task_message_task_id"`);
        await queryRunner.query(`DROP TABLE "task_messages"`);
        await queryRunner.query(`DROP TYPE "public"."task_messages_role_enum"`);
        await queryRunner.query(`ALTER TABLE "tasks" DROP COLUMN "chat"`);
    }

}
