import { FormDefinition } from '../entities/form-definition.entity.js';

interface FieldRule {
  allowedRoles?: string[];
  allowedGroups?: string[];
}

type VisibilityRules = Record<string, FieldRule>;

function isVisible(
  field: string,
  rules: VisibilityRules,
  userRoleNames: string[],
  userGroupNames: string[],
): boolean {
  const rule = rules[field];
  if (!rule) return true;

  const roles = rule.allowedRoles ?? [];
  const groups = rule.allowedGroups ?? [];
  if (roles.length === 0 && groups.length === 0) return true;

  return (
    roles.some((r) => userRoleNames.includes(r)) ||
    groups.some((g) => userGroupNames.includes(g))
  );
}

type JsonSchema = {
  type?: string;
  properties?: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
};

type UiElement = { scope?: string; [key: string]: unknown };

type UiSchema = {
  elements?: UiElement[];
  [key: string]: unknown;
};

export function filterFormSchemas(
  form: FormDefinition,
  userRoleNames: string[],
  userGroupNames: string[],
): { jsonSchema: Record<string, unknown>; uiSchema: Record<string, unknown> } {
  const rules = form.visibilityRules as VisibilityRules;
  if (!rules || Object.keys(rules).length === 0) {
    return { jsonSchema: form.jsonSchema, uiSchema: form.uiSchema };
  }

  const jsonSchema = form.jsonSchema as JsonSchema;
  if (!jsonSchema.properties) {
    return { jsonSchema: form.jsonSchema, uiSchema: form.uiSchema };
  }

  const visibleFields = new Set(
    Object.keys(jsonSchema.properties).filter((f) =>
      isVisible(f, rules, userRoleNames, userGroupNames),
    ),
  );

  const filteredJson: JsonSchema = {
    ...jsonSchema,
    properties: Object.fromEntries(
      [...visibleFields].map((f) => [f, jsonSchema.properties![f]]),
    ),
    required: (jsonSchema.required ?? []).filter((f) => visibleFields.has(f)),
  };

  const uiSchema = form.uiSchema as UiSchema;
  let filteredUi: UiSchema = uiSchema;
  if (uiSchema.elements) {
    filteredUi = {
      ...uiSchema,
      elements: uiSchema.elements.filter((el) => {
        if (!el.scope) return true;
        const match = /^#\/properties\/(.+)$/.exec(el.scope);
        return !match || visibleFields.has(match[1]);
      }),
    };
  }

  return {
    jsonSchema: filteredJson as Record<string, unknown>,
    uiSchema: filteredUi as Record<string, unknown>,
  };
}

export function filterSubmissionData(
  data: Record<string, unknown>,
  form: FormDefinition,
  userRoleNames: string[],
  userGroupNames: string[],
): Record<string, unknown> {
  const rules = form.visibilityRules as VisibilityRules;
  if (!rules || Object.keys(rules).length === 0) return data;

  return Object.fromEntries(
    Object.entries(data).filter(([k]) =>
      isVisible(k, rules, userRoleNames, userGroupNames),
    ),
  );
}
