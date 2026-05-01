import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { FormDefinition } from '../entities/form-definition.entity.js';
import { FormDefinitionStatus } from '../common/enums.js';
import { requireAuth, requirePermission } from '../plugins/auth.js';
import { Permissions } from '../common/permissions.js';
import { PaginationQuery, paginate } from '../common/pagination.js';

const CodeParam = z.object({ code: z.string().min(1) });
const JsonObject = z.record(z.string(), z.unknown());

const CreateFormBody = z.object({
  code: z.string().min(1),
  jsonSchema: JsonObject,
  uiSchema: JsonObject.optional(),
  visibilityRules: JsonObject.optional(),
  formMessages: JsonObject.optional(),
});

const DraftFormBody = z.object({
  jsonSchema: JsonObject.optional(),
  uiSchema: JsonObject.optional(),
  visibilityRules: JsonObject.optional(),
  formMessages: JsonObject.optional(),
});

export const formRoutes: FastifyPluginAsyncZod = async (app) => {
  const read = { preHandler: [requireAuth] };
  const write = { preHandler: [requirePermission(Permissions.FORMS_WRITE)] };
  const repo = () => app.db.getRepository(FormDefinition);

  app.get('/forms', { ...read, schema: { querystring: PaginationQuery } }, async (request) => {
    const { limit, offset } = request.query;
    const all = await repo().find({ order: { code: 'ASC', version: 'ASC' } });

    const byCode = new Map<string, { published: FormDefinition[]; draft: FormDefinition | null }>();
    for (const f of all) {
      if (!byCode.has(f.code)) byCode.set(f.code, { published: [], draft: null });
      const entry = byCode.get(f.code)!;
      if (f.status === FormDefinitionStatus.PUBLISHED) {
        entry.published.push(f);
      } else {
        entry.draft = f;
      }
    }

    const grouped = [...byCode.entries()].map(([code, { published, draft }]) => {
      const latest = published[published.length - 1] ?? null;
      return {
        code,
        latestPublishedVersion: latest?.version ?? null,
        hasDraft: draft !== null,
        latestPublished: latest,
      };
    });

    return paginate(grouped.slice(offset, offset + limit), grouped.length, limit, offset);
  });

  app.post('/forms', { ...write, schema: { body: CreateFormBody } }, async (request, reply) => {
    const { code, jsonSchema, uiSchema, visibilityRules, formMessages } = request.body;

    const existing = await repo().findOne({ where: { code } });
    if (existing) return reply.code(409).send({ error: `Form code '${code}' already exists` });

    const form = await repo().save({
      code,
      version: 1,
      jsonSchema,
      uiSchema: uiSchema ?? {},
      visibilityRules: visibilityRules ?? {},
      formMessages: formMessages ?? {},
      status: FormDefinitionStatus.DRAFT,
    });

    return reply.code(201).send(form);
  });

  app.get(
    '/forms/:code',
    { ...read, schema: { params: CodeParam } },
    async (request, reply) => {
      const { code } = request.params;

      const forms = await repo().find({
        where: { code, status: FormDefinitionStatus.PUBLISHED },
        order: { version: 'DESC' },
      });

      if (!forms.length) return reply.code(404).send({ error: 'No published version found' });
      return forms[0];
    },
  );

  app.get(
    '/forms/:code/versions',
    { ...write, schema: { params: CodeParam } },
    async (request, reply) => {
      const { code } = request.params;

      const forms = await repo().find({
        where: { code },
        order: { version: 'ASC' },
      });

      if (!forms.length) return reply.code(404).send({ error: 'Form not found' });
      return forms;
    },
  );

  app.put(
    '/forms/:code/draft',
    { ...write, schema: { params: CodeParam, body: DraftFormBody } },
    async (request, reply) => {
      const { code } = request.params;
      const { jsonSchema, uiSchema, visibilityRules, formMessages } = request.body;

      let draft = await repo().findOne({
        where: { code, status: FormDefinitionStatus.DRAFT },
      });

      if (draft) {
        if (jsonSchema !== undefined) draft.jsonSchema = jsonSchema;
        if (uiSchema !== undefined) draft.uiSchema = uiSchema;
        if (visibilityRules !== undefined) draft.visibilityRules = visibilityRules;
        if (formMessages !== undefined) draft.formMessages = formMessages;
        await repo().save(draft);
      } else {
        const published = await repo().find({
          where: { code, status: FormDefinitionStatus.PUBLISHED },
          order: { version: 'DESC' },
        });
        if (!published.length) return reply.code(404).send({ error: 'Form not found' });

        const nextVersion = published[0].version + 1;
        draft = await repo().save({
          code,
          version: nextVersion,
          jsonSchema: jsonSchema ?? published[0].jsonSchema,
          uiSchema: uiSchema ?? published[0].uiSchema,
          visibilityRules: visibilityRules ?? published[0].visibilityRules,
          formMessages: formMessages ?? published[0].formMessages,
          status: FormDefinitionStatus.DRAFT,
        });
        return reply.code(201).send(draft);
      }

      return draft;
    },
  );

  app.post(
    '/forms/:code/publish',
    { ...write, schema: { params: CodeParam } },
    async (request, reply) => {
      const { code } = request.params;

      const published = await app.db.transaction(async (em) => {
        const formRepo = em.getRepository(FormDefinition);

        // Pessimistic lock serializes concurrent publish requests:
        // the second caller blocks here until the first commits/rolls back,
        // then finds no draft and returns null (→ 404).
        const draft = await formRepo.findOne({
          where: { code, status: FormDefinitionStatus.DRAFT },
          lock: { mode: 'pessimistic_write' },
        });
        if (!draft) return null;

        const result = await formRepo
          .createQueryBuilder('f')
          .select('MAX(f.version)', 'max')
          .where('f.code = :code AND f.status = :status', {
            code,
            status: FormDefinitionStatus.PUBLISHED,
          })
          .getRawOne<{ max: number | null }>();

        const nextVersion = (result?.max ?? 0) + 1;

        // Update the draft in-place to avoid unique constraint violation
        // on (code, version) — can't INSERT before DELETE in same tx
        draft.version = nextVersion;
        draft.status = FormDefinitionStatus.PUBLISHED;
        return formRepo.save(draft);
      });

      if (!published) return reply.code(404).send({ error: 'No draft found for this code' });
      return reply.code(201).send(published);
    },
  );
};
