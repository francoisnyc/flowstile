# Form Designer UI — Design Spec

## Goal

Replace the raw JSON editor with a visual drag-and-drop form builder that lets non-technical users create and edit JSON Schema forms. Power users retain access to the raw JSON via a Source tab. The builder outputs standard JSON Schema + JsonForms UISchema — no new server endpoints, no database changes.

## Audience

Primary: admin/ops users who configure task workflows and understand data structures but aren't developers. Secondary: developers who want a faster authoring experience with a raw JSON escape hatch.

## Architecture

The form designer is a client-side React feature. The existing form CRUD API (`GET/POST/PUT /forms`) and JsonForms rendering in TaskDetail are unchanged. The designer provides a visual way to author the JSON Schema + UISchema that the API stores and JsonForms renders.

### Component Tree

```
FormDesignerPage (existing, refactored)
├── FormListSidebar (existing — form list, create, select)
├── DesignerToolbar (new — tabs: Designer | Source | Preview, plus Publish button)
└── TabContent
    ├── VisualBuilder (new — three-panel builder)
    │   ├── FieldPalette (new — draggable field type tiles)
    │   ├── FormCanvas (new — drop zone, sortable field list with nesting)
    │   │   └── CanvasField (new — single field, recursive for groups)
    │   └── PropertiesPanel (new — edit selected field config)
    ├── FormEditor (existing — Monaco JSON tabs, bidirectional sync)
    └── FormPreview (existing — JsonForms live render)
```

### Data Flow

- The visual builder works on an internal `FieldDefinition[]` — a discriminated union of field objects.
- On every change, a `toSchema()` function converts this array to `{ jsonSchema, uiSchema, visibilityRules }`.
- When switching to the Source tab, the current schemas are shown in Monaco.
- When switching back from Source, a `fromSchema()` function parses the JSON Schema + UISchema back into `FieldDefinition[]`.
- The Preview tab passes the current schemas to JsonForms (already works).
- The `FieldDefinition[]` is the builder's working model but is never persisted. The source of truth is always JSON Schema + UISchema.

## Layout

Three-panel drag-and-drop builder:

- **Left: Field Palette** — draggable tiles for each field type
- **Center: Form Canvas** — drop zone with sortable field list, supports nesting for sections and repeat groups
- **Right: Properties Panel** — edit selected field's configuration (label, key, validation, visibility)

Three tabs above the workspace:
- **Designer** (default) — the visual builder
- **Source** — Monaco JSON editor (existing FormEditor component)
- **Preview** — rendered form via JsonForms (existing FormPreview component)

## Field Types

The builder supports these field types in v1:

| Type | JSON Schema | Notes |
|------|-------------|-------|
| text | `{ type: "string" }` | Optional minLength, maxLength, pattern |
| number | `{ type: "number" }` | Optional minimum, maximum |
| boolean | `{ type: "boolean" }` | Renders as checkbox |
| select | `{ type: "string", enum: [...] }` | Options list configured in properties |
| textarea | `{ type: "string" }` + `options.multi` | Multiline text |
| date | `{ type: "string", format: "date" }` | Date picker |
| email | `{ type: "string", format: "email" }` | Optional pattern override |
| section | N/A (UISchema `Group`) | Visual grouping, no schema property |
| repeat | `{ type: "array", items: { type: "object" } }` | Contains child fields |

## Field Model

### Base Type

```typescript
interface BaseField {
  id: string;                          // crypto.randomUUID(), unique within session
  key: string;                         // JSON Schema property name, e.g. 'CUSTOMER_NAME'
  label: string;                       // display label
  required: boolean;
  visibility?: CompoundVisibility;
  options?: { placeholder?: string; helpText?: string };
}

interface CompoundVisibility {
  operator: 'and' | 'or';
  conditions: {
    field: string;                     // key of the controlling field
    op: 'equals' | 'notEquals' | 'greaterThan' | 'lessThan' | 'exists' | 'notExists';
    value?: unknown;
  }[];
}
```

### Discriminated Union

```typescript
type FieldDefinition =
  | BaseField & { type: 'text'; minLength?: number; maxLength?: number; pattern?: string }
  | BaseField & { type: 'number'; minimum?: number; maximum?: number }
  | BaseField & { type: 'boolean' }
  | BaseField & { type: 'select'; enumValues: string[] }
  | BaseField & { type: 'textarea'; minLength?: number; maxLength?: number }
  | BaseField & { type: 'date' }
  | BaseField & { type: 'email'; pattern?: string }
  | Omit<BaseField, 'required'> & { type: 'section'; children: FieldDefinition[] }
  | BaseField & { type: 'repeat'; children: FieldDefinition[] }
  | BaseField & { type: 'unsupported'; jsonSchemaFragment: unknown; uiSchemaFragment?: unknown }
```

The `unsupported` variant preserves hand-authored schema constructs (`$ref`, `oneOf`, `allOf`, `anyOf`) that the visual builder can't represent. These appear as non-editable chips on the canvas and are merged back verbatim by `toSchema()`.

## Key Generation

- Auto-derived from label on creation: `"Loan Amount"` → `"LOAN_AMOUNT"` (uppercase, underscores for spaces, strip non-alphanumeric)
- Checked for uniqueness within the form — append `_2`, `_3` on collision
- Key becomes a separate editable field in the properties panel that does NOT auto-update when the label changes after initial creation
- Key editability by form state:
  - **Draft (never published):** freely editable
  - **Draft (has published versions):** editable with warning: "This key exists in published version N — changing it will break data bindings"
  - **Published:** read-only

## Drag-and-Drop

**Library:** `@dnd-kit/core` + `@dnd-kit/sortable` + `@dnd-kit/utilities`

### Interactions

**Palette → Canvas (add):**
- Palette items are drag sources. Canvas is a drop zone.
- Dropping creates a new `FieldDefinition` with default label and auto-generated key.
- Drop position determines insertion index. A horizontal indicator line shows where the field will land.
- Dropping onto a section or repeat group container inserts inside it.

**Canvas → Canvas (reorder):**
- Fields are sortable via drag handles (grip icon).
- Drag between fields to reorder. Drag into/out of containers to change nesting.
- Containers accept drops when dragging over their body area (highlighted border).

**Nested drop zones:**
- Custom collision detection strategy for dnd-kit to distinguish "drop between fields" (line indicator) from "drop into container" (container highlight).
- Nesting depth capped at 2 levels: fields inside containers, but no containers inside containers. Enforced in the drop handler.

**Delete:**
- Trash icon on canvas field (visible on hover/select).
- "Delete field" button at bottom of properties panel.
- Confirmation if the field's key is referenced by another field's visibility rule.

### Selection

- Click a field to select it (highlighted border). Properties panel updates.
- Click empty canvas to deselect.
- Single selection only.

### Keyboard

- Tab through fields on canvas
- Delete key removes selected field (with confirmation)
- Alt+Arrow Up/Down to reorder selected field
- Standard focus management for accessibility

## Schema Sync (Bidirectional)

### Builder Marker

Schemas created by the builder include `"x-flowstile-builder": true` in the JSON Schema root. This marker controls whether the visual builder tab is available.

### Visual → Source

On tab switch to Source, `toSchema(fields)` produces `{ jsonSchema, uiSchema, visibilityRules }` and populates Monaco.

### Source → Visual

On tab switch to Designer:
- If `"x-flowstile-builder": true` is present: `fromSchema()` parses back into `FieldDefinition[]`.
- If marker is absent: show confirmation — "This schema may contain constructs the visual builder can't represent. Switch anyway? Unsupported constructs will be preserved but not editable."
- If JSON has syntax errors: block tab switch with inline error — "Fix JSON syntax errors before switching to Designer."

### `fromSchema()` Handling

| Construct | Handled | Fallback |
|-----------|---------|----------|
| `string`, `number`, `boolean`, `integer` | Yes → appropriate field type | — |
| `string` with `enum` | Yes → select | — |
| `string` with `format: "date"` | Yes → date | — |
| `string` with `format: "email"` | Yes → email | — |
| `string` with `options.multi` in UISchema | Yes → textarea | — |
| `array` with `items: { type: 'object' }` | Yes → repeat group | — |
| UISchema `Group` | Yes → section | — |
| `oneOf`, `anyOf`, `$ref`, `allOf` | No | `unsupported` variant — preserved, shown as chip |
| Properties not in UISchema | No | `unsupported` variant appended at end |

### Round-Trip Safety

`toSchema()` merges `unsupported` field definitions back into the output verbatim. The `x-flowstile-builder` marker is re-added by `toSchema()` on every conversion.

## Visibility Rules

### Data Model

```typescript
interface CompoundVisibility {
  operator: 'and' | 'or';
  conditions: {
    field: string;       // key of controlling field
    op: 'equals' | 'notEquals' | 'greaterThan' | 'lessThan' | 'exists' | 'notExists';
    value?: unknown;
  }[];
}
```

Single conditions are expressed as `{ operator: 'and', conditions: [{ ... }] }`.

### Serialization

Stored in the `visibilityRules` jsonb column on FormDefinition, keyed by target field key:

```json
{
  "NOTES": {
    "operator": "and",
    "conditions": [
      { "field": "DECISION", "op": "equals", "value": "REJECTED" }
    ]
  }
}
```

Server passes this through to the UI. Evaluation happens client-side in the JsonForms rendering layer.

### Properties Panel UI

The visibility section of the properties panel shows:
- AND/OR toggle
- List of conditions, each with: field dropdown (other fields in the form), operator dropdown, value input
- "+ Add condition" button
- Condition rows are removable

## Undo/Redo

- History stack of `FieldDefinition[]` snapshots, capped at 50 entries.
- Push snapshot on every meaningful action: add field, delete field, reorder, property change.
- Ctrl+Z pops from history (undo). Ctrl+Shift+Z pushes back (redo).
- History resets when switching tabs (Source edits have Monaco's own undo).

## File Structure

### New Files

```
packages/ui/src/components/form-designer/
├── VisualBuilder.tsx          — three-panel layout container
├── FieldPalette.tsx           — draggable field type tiles
├── FormCanvas.tsx             — drop zone + sortable field list
├── CanvasField.tsx            — single field on canvas (recursive for groups)
├── PropertiesPanel.tsx        — edit selected field config
├── DesignerToolbar.tsx        — tab switcher + publish button
├── VisibilityEditor.tsx       — compound condition builder
├── types.ts                   — FieldDefinition union, CompoundVisibility, FieldType
├── toSchema.ts                — FieldDefinition[] → { jsonSchema, uiSchema, visibilityRules }
├── fromSchema.ts              — { jsonSchema, uiSchema } → FieldDefinition[]
├── keyUtils.ts                — label-to-key generation, uniqueness check
└── useHistory.ts              — undo/redo hook
```

### Modified Files

- `FormDesignerPage.tsx` — refactor to use DesignerToolbar + tab switching
- `packages/ui/package.json` — add `@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/utilities`

### No Server Changes

No new API endpoints, no database migrations, no entity changes.

## Testing

### Unit Tests

- `toSchema.test.ts` — every field type conversion, required fields, sections, repeat groups, visibility rules, unsupported passthrough
- `fromSchema.test.ts` — reverse mapping for all supported constructs, unknown construct handling, marker detection
- `keyUtils.test.ts` — label-to-key conversion, collision handling, edge cases (empty label, special characters)
- Round-trip tests — `fromSchema(toSchema(fields))` preserves field definitions including unsupported variants

### E2E Test

One Playwright smoke test: create form → add fields via drag → configure properties → preview → publish → verify saved schema matches expectations.

## Dependencies

- `@dnd-kit/core` (~8kb gzipped)
- `@dnd-kit/sortable` (~3kb gzipped)
- `@dnd-kit/utilities` (~1kb gzipped)

No other new dependencies. Builds on existing JsonForms and Monaco integrations.
