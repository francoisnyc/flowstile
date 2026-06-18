import { MigrationInterface, QueryRunner } from "typeorm";

export class InitialSchema1781784778888 implements MigrationInterface {
    name = 'InitialSchema1781784778888'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "groups" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "name" character varying NOT NULL, CONSTRAINT "UQ_664ea405ae2a10c264d582ee563" UNIQUE ("name"), CONSTRAINT "PK_659d1483316afb28afd3a90646e" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "roles" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "name" character varying NOT NULL, "permissions" text array NOT NULL DEFAULT '{}', CONSTRAINT "UQ_648e3f5447f725579d7d4ffdfb7" UNIQUE ("name"), CONSTRAINT "PK_c1433d71a4838793a49dcad46ab" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TYPE "public"."users_status_enum" AS ENUM('active', 'inactive')`);
        await queryRunner.query(`CREATE TABLE "users" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "email" character varying NOT NULL, "displayName" character varying NOT NULL, "passwordHash" character varying NOT NULL, "status" "public"."users_status_enum" NOT NULL DEFAULT 'active', "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_97672ac88f789774dd47f7c8be3" UNIQUE ("email"), CONSTRAINT "PK_a3ffb1c0c8416b9fc6f907b7433" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TYPE "public"."form_definitions_status_enum" AS ENUM('draft', 'published')`);
        await queryRunner.query(`CREATE TABLE "form_definitions" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "code" character varying NOT NULL, "version" integer NOT NULL, "jsonSchema" jsonb NOT NULL, "uiSchema" jsonb NOT NULL DEFAULT '{}', "visibilityRules" jsonb NOT NULL DEFAULT '{}', "formMessages" jsonb NOT NULL DEFAULT '{}', "outcomes" jsonb, "outcomeKey" character varying, "status" "public"."form_definitions_status_enum" NOT NULL DEFAULT 'draft', "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "uq_form_code_version" UNIQUE ("code", "version"), CONSTRAINT "PK_e7b46c89a49ab24f30618b410d9" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TYPE "public"."task_definitions_defaultpriority_enum" AS ENUM('low', 'normal', 'high', 'urgent')`);
        await queryRunner.query(`CREATE TABLE "task_definitions" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "code" character varying NOT NULL, "process_definition_id" uuid NOT NULL, "formDefinitionCode" character varying NOT NULL, "milestoneCode" character varying, "candidateGroups" text array NOT NULL DEFAULT '{}', "candidateUsers" text array NOT NULL DEFAULT '{}', "defaultPriority" "public"."task_definitions_defaultpriority_enum" NOT NULL DEFAULT 'normal', "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_8a9ceb0c89bfa0b76e8504824bf" UNIQUE ("code"), CONSTRAINT "PK_bf360a3dd75a167966755a9b313" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TYPE "public"."process_definitions_status_enum" AS ENUM('active', 'inactive')`);
        await queryRunner.query(`CREATE TABLE "process_definitions" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "name" character varying NOT NULL, "version" integer NOT NULL DEFAULT '1', "status" "public"."process_definitions_status_enum" NOT NULL DEFAULT 'active', "caseEntitySchema" jsonb, "milestones" jsonb, "startFormCode" character varying, "workflowType" character varying, "taskQueue" character varying, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_068dfeb73af76e704e113f61ba1" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TYPE "public"."tasks_status_enum" AS ENUM('created', 'claimed', 'completed', 'cancelled')`);
        await queryRunner.query(`CREATE TYPE "public"."tasks_priority_enum" AS ENUM('low', 'normal', 'high', 'urgent')`);
        await queryRunner.query(`CREATE TYPE "public"."tasks_signalstatus_enum" AS ENUM('not_applicable', 'pending', 'delivered', 'failed')`);
        await queryRunner.query(`CREATE TABLE "tasks" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "task_definition_id" uuid NOT NULL, "formDefinitionVersion" integer NOT NULL, "workflowId" character varying NOT NULL, "processInstanceId" character varying, "status" "public"."tasks_status_enum" NOT NULL DEFAULT 'created', "assignee_id" uuid, "candidateGroups" text array NOT NULL DEFAULT '{}', "candidateUsers" text array NOT NULL DEFAULT '{}', "inputData" jsonb NOT NULL DEFAULT '{}', "contextData" jsonb NOT NULL DEFAULT '{}', "submissionData" jsonb NOT NULL DEFAULT '{}', "priority" "public"."tasks_priority_enum" NOT NULL DEFAULT 'normal', "dueDate" TIMESTAMP WITH TIME ZONE, "followUpDate" TIMESTAMP WITH TIME ZONE, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), "completedAt" TIMESTAMP WITH TIME ZONE, "signalStatus" "public"."tasks_signalstatus_enum", "signalDeliveredAt" TIMESTAMP WITH TIME ZONE, "signalFailedAt" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_8d12ff38fcc62aaba2cab748772" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "idx_task_status_assignee" ON "tasks" ("status", "assignee_id") `);
        await queryRunner.query(`CREATE INDEX "idx_task_assignee" ON "tasks" ("assignee_id") `);
        await queryRunner.query(`CREATE INDEX "idx_task_status" ON "tasks" ("status") `);
        await queryRunner.query(`CREATE TYPE "public"."signal_outbox_status_enum" AS ENUM('pending', 'delivered', 'failed')`);
        await queryRunner.query(`CREATE TABLE "signal_outbox" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "taskId" uuid NOT NULL, "workflowId" character varying NOT NULL, "signalName" character varying NOT NULL, "payload" jsonb, "status" "public"."signal_outbox_status_enum" NOT NULL DEFAULT 'pending', "attempts" integer NOT NULL DEFAULT '0', "maxAttempts" integer NOT NULL DEFAULT '10', "nextAttemptAt" TIMESTAMP WITH TIME ZONE NOT NULL, "lastError" text, "deliveredAt" TIMESTAMP WITH TIME ZONE, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_fac3a74a75f712c71ebc27808a2" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "idx_outbox_task" ON "signal_outbox" ("taskId") `);
        await queryRunner.query(`CREATE INDEX "idx_outbox_status_next" ON "signal_outbox" ("status", "nextAttemptAt") `);
        await queryRunner.query(`CREATE TYPE "public"."attachments_status_enum" AS ENUM('pending', 'linked')`);
        await queryRunner.query(`CREATE TABLE "attachments" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "taskId" uuid, "processInstanceId" character varying, "fieldKey" character varying, "payloadScope" character varying, "storageKey" character varying NOT NULL, "storeId" character varying NOT NULL, "fileName" character varying NOT NULL, "contentType" character varying NOT NULL, "size" bigint NOT NULL, "checksum" character varying NOT NULL, "uploadedById" uuid, "status" "public"."attachments_status_enum" NOT NULL DEFAULT 'pending', "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "linkedAt" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_5e1f050bcff31e3084a1d662412" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "idx_attachment_status_created_at" ON "attachments" ("status", "createdAt") `);
        await queryRunner.query(`CREATE INDEX "idx_attachment_process_instance_id" ON "attachments" ("processInstanceId") `);
        await queryRunner.query(`CREATE INDEX "idx_attachment_task_id" ON "attachments" ("taskId") `);
        await queryRunner.query(`CREATE TABLE "cases" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "processInstanceId" character varying NOT NULL, "processDefinitionId" uuid, "title" character varying, "entity" jsonb, "entityVersion" integer NOT NULL DEFAULT '0', "startedById" uuid, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_8b8632f57b3baf5d1c4050a0b1a" UNIQUE ("processInstanceId"), CONSTRAINT "PK_264acb3048c240fb89aa34626db" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "idx_case_process_definition_id" ON "cases" ("processDefinitionId") `);
        await queryRunner.query(`CREATE TABLE "api_keys" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "name" character varying NOT NULL, "keyHash" character varying NOT NULL, "prefix" character varying NOT NULL, "permissions" text array NOT NULL DEFAULT '{}', "lastUsedAt" TIMESTAMP, "expiresAt" TIMESTAMP, "revokedAt" TIMESTAMP, "createdById" uuid, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_df3b25181df0b4b59bd93f16e10" UNIQUE ("keyHash"), CONSTRAINT "PK_5c8a79801b44bd27b79228e1dad" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "case_comments" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "caseId" uuid NOT NULL, "authorId" uuid NOT NULL, "body" text NOT NULL, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_e309fb1394ca40f0f931642981f" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "idx_case_comment_case_id" ON "case_comments" ("caseId") `);
        await queryRunner.query(`CREATE TABLE "group_members" ("user_id" uuid NOT NULL, "group_id" uuid NOT NULL, CONSTRAINT "PK_f5939ee0ad233ad35e03f5c65c1" PRIMARY KEY ("user_id", "group_id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_20a555b299f75843aa53ff8b0e" ON "group_members" ("user_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_2c840df5db52dc6b4a1b0b69c6" ON "group_members" ("group_id") `);
        await queryRunner.query(`CREATE TABLE "user_roles" ("user_id" uuid NOT NULL, "role_id" uuid NOT NULL, CONSTRAINT "PK_23ed6f04fe43066df08379fd034" PRIMARY KEY ("user_id", "role_id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_87b8888186ca9769c960e92687" ON "user_roles" ("user_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_b23c65e50a758245a33ee35fda" ON "user_roles" ("role_id") `);
        await queryRunner.query(`ALTER TABLE "task_definitions" ADD CONSTRAINT "FK_d9772d008a1ba68ac14e32c013e" FOREIGN KEY ("process_definition_id") REFERENCES "process_definitions"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "tasks" ADD CONSTRAINT "FK_455dd62df7cbabffddc6258bc2f" FOREIGN KEY ("task_definition_id") REFERENCES "task_definitions"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "tasks" ADD CONSTRAINT "FK_855d484825b715c545349212c7f" FOREIGN KEY ("assignee_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "case_comments" ADD CONSTRAINT "FK_1ba49d4b9fec275bcdd9b06498b" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "group_members" ADD CONSTRAINT "FK_20a555b299f75843aa53ff8b0ee" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE`);
        await queryRunner.query(`ALTER TABLE "group_members" ADD CONSTRAINT "FK_2c840df5db52dc6b4a1b0b69c6e" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "user_roles" ADD CONSTRAINT "FK_87b8888186ca9769c960e926870" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE`);
        await queryRunner.query(`ALTER TABLE "user_roles" ADD CONSTRAINT "FK_b23c65e50a758245a33ee35fda1" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "user_roles" DROP CONSTRAINT "FK_b23c65e50a758245a33ee35fda1"`);
        await queryRunner.query(`ALTER TABLE "user_roles" DROP CONSTRAINT "FK_87b8888186ca9769c960e926870"`);
        await queryRunner.query(`ALTER TABLE "group_members" DROP CONSTRAINT "FK_2c840df5db52dc6b4a1b0b69c6e"`);
        await queryRunner.query(`ALTER TABLE "group_members" DROP CONSTRAINT "FK_20a555b299f75843aa53ff8b0ee"`);
        await queryRunner.query(`ALTER TABLE "case_comments" DROP CONSTRAINT "FK_1ba49d4b9fec275bcdd9b06498b"`);
        await queryRunner.query(`ALTER TABLE "tasks" DROP CONSTRAINT "FK_855d484825b715c545349212c7f"`);
        await queryRunner.query(`ALTER TABLE "tasks" DROP CONSTRAINT "FK_455dd62df7cbabffddc6258bc2f"`);
        await queryRunner.query(`ALTER TABLE "task_definitions" DROP CONSTRAINT "FK_d9772d008a1ba68ac14e32c013e"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_b23c65e50a758245a33ee35fda"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_87b8888186ca9769c960e92687"`);
        await queryRunner.query(`DROP TABLE "user_roles"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_2c840df5db52dc6b4a1b0b69c6"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_20a555b299f75843aa53ff8b0e"`);
        await queryRunner.query(`DROP TABLE "group_members"`);
        await queryRunner.query(`DROP INDEX "public"."idx_case_comment_case_id"`);
        await queryRunner.query(`DROP TABLE "case_comments"`);
        await queryRunner.query(`DROP TABLE "api_keys"`);
        await queryRunner.query(`DROP INDEX "public"."idx_case_process_definition_id"`);
        await queryRunner.query(`DROP TABLE "cases"`);
        await queryRunner.query(`DROP INDEX "public"."idx_attachment_task_id"`);
        await queryRunner.query(`DROP INDEX "public"."idx_attachment_process_instance_id"`);
        await queryRunner.query(`DROP INDEX "public"."idx_attachment_status_created_at"`);
        await queryRunner.query(`DROP TABLE "attachments"`);
        await queryRunner.query(`DROP TYPE "public"."attachments_status_enum"`);
        await queryRunner.query(`DROP INDEX "public"."idx_outbox_status_next"`);
        await queryRunner.query(`DROP INDEX "public"."idx_outbox_task"`);
        await queryRunner.query(`DROP TABLE "signal_outbox"`);
        await queryRunner.query(`DROP TYPE "public"."signal_outbox_status_enum"`);
        await queryRunner.query(`DROP INDEX "public"."idx_task_status"`);
        await queryRunner.query(`DROP INDEX "public"."idx_task_assignee"`);
        await queryRunner.query(`DROP INDEX "public"."idx_task_status_assignee"`);
        await queryRunner.query(`DROP TABLE "tasks"`);
        await queryRunner.query(`DROP TYPE "public"."tasks_signalstatus_enum"`);
        await queryRunner.query(`DROP TYPE "public"."tasks_priority_enum"`);
        await queryRunner.query(`DROP TYPE "public"."tasks_status_enum"`);
        await queryRunner.query(`DROP TABLE "process_definitions"`);
        await queryRunner.query(`DROP TYPE "public"."process_definitions_status_enum"`);
        await queryRunner.query(`DROP TABLE "task_definitions"`);
        await queryRunner.query(`DROP TYPE "public"."task_definitions_defaultpriority_enum"`);
        await queryRunner.query(`DROP TABLE "form_definitions"`);
        await queryRunner.query(`DROP TYPE "public"."form_definitions_status_enum"`);
        await queryRunner.query(`DROP TABLE "users"`);
        await queryRunner.query(`DROP TYPE "public"."users_status_enum"`);
        await queryRunner.query(`DROP TABLE "roles"`);
        await queryRunner.query(`DROP TABLE "groups"`);
    }

}
