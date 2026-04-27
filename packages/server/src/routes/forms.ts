import { FastifyInstance } from 'fastify';
import { FormDefinition } from '../entities/form-definition.entity.js';
import { FormDefinitionStatus } from '../common/enums.js';
import { requireAuth } from '../plugins/auth.js';

export async function formRoutes(app: FastifyInstance) {
  const pre = { preHandler: [requireAuth] };
  const repo = () => app.db.getRepository(FormDefinition);

  // List all form codes with their latest published version (+ draft flag)
  app.get('/forms', pre, async () => {
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

    return [...byCode.entries()].map(([code, { published, draft }]) => {
      const latest = published[published.length - 1] ?? null;
      return {
        code,
        latestPublishedVersion: latest?.version ?? null,
        hasDraft: draft !== null,
        latestPublished: latest,
      };
    });
  });

  // Create a new form (new code, starts as draft v1)
  app.post('/forms', pre, async (request, reply) => {
    const { code, jsonSchema, uiSchema, visibilityRules, formMessages } = request.body as {
      code: string;
      jsonSchema: Record<string, unknown>;
      uiSchema?: Record<string, unknown>;
      visibilityRules?: Record<string, unknown>;
      formMessages?: Record<string, unknown>;
    };

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

  // Get the latest published version for a code
  app.get('/forms/:code', pre, async (request, reply) => {
    const { code } = request.params as { code: string };

    const forms = await repo().find({
      where: { code, status: FormDefinitionStatus.PUBLISHED },
      order: { version: 'DESC' },
    });

    if (!forms.length) return reply.code(404).send({ error: 'No published version found' });
    return forms[0];
  });

  // List all versions for a code
  app.get('/forms/:code/versions', pre, async (request, reply) => {
    const { code } = request.params as { code: string };

    const forms = await repo().find({
      where: { code },
      order: { version: 'ASC' },
    });

    if (!forms.length) return reply.code(404).send({ error: 'Form not found' });
    return forms;
  });

  // Upsert the draft for a code
  app.put('/forms/:code/draft', pre, async (request, reply) => {
    const { code } = request.params as { code: string };
    const { jsonSchema, uiSchema, visibilityRules, formMessages } = request.body as {
      jsonSchema?: Record<string, unknown>;
      uiSchema?: Record<string, unknown>;
      visibilityRules?: Record<string, unknown>;
      formMessages?: Record<string, unknown>;
    };

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
      // No draft exists — create one at the next version
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
  });

  // Publish the current draft
  app.post('/forms/:code/publish', pre, async (request, reply) => {
    const { code } = request.params as { code: string };

    const draft = await repo().findOne({
      where: { code, status: FormDefinitionStatus.DRAFT },
    });
    if (!draft) return reply.code(404).send({ error: 'No draft found for this code' });

    // Determine next version number
    const result = await repo()
      .createQueryBuilder('f')
      .select('MAX(f.version)', 'max')
      .where('f.code = :code AND f.status = :status', {
        code,
        status: FormDefinitionStatus.PUBLISHED,
      })
      .getRawOne<{ max: number | null }>();

    const nextVersion = (result?.max ?? 0) + 1;

    const published = await repo().save({
      code: draft.code,
      version: nextVersion,
      jsonSchema: draft.jsonSchema,
      uiSchema: draft.uiSchema,
      visibilityRules: draft.visibilityRules,
      formMessages: draft.formMessages,
      status: FormDefinitionStatus.PUBLISHED,
    });

    await repo().delete(draft.id);

    return reply.code(201).send(published);
  });
}
