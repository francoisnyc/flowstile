import React, { useCallback, useState } from 'react';
import {
  DndContext, DragOverlay, closestCenter,
  PointerSensor, KeyboardSensor, useSensor, useSensors,
} from '@dnd-kit/core';
import type { DragStartEvent, DragEndEvent, Active } from '@dnd-kit/core';
import { sortableKeyboardCoordinates, arrayMove } from '@dnd-kit/sortable';
import FieldPalette from './FieldPalette.js';
import FormCanvas from './FormCanvas.js';
import PropertiesPanel from './PropertiesPanel.js';
import type { FieldDefinition, FieldType } from './types.js';
import { FIELD_TYPE_LABELS } from './types.js';
import { labelToKey, ensureUnique } from './keyUtils.js';

const MAX_DEPTH = 2;

interface Props {
  fields: FieldDefinition[];
  onChange: (fields: FieldDefinition[]) => void;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  hasPublishedVersions: boolean;
}

// ── Tree helpers ────────────────────────────────────────────────────────────

function collectKeys(fields: FieldDefinition[]): Set<string> {
  const keys = new Set<string>();
  function walk(list: FieldDefinition[]) {
    for (const f of list) {
      keys.add(f.key);
      if ('children' in f && f.children) walk(f.children);
    }
  }
  walk(fields);
  return keys;
}

function findFieldIndex(fields: FieldDefinition[], id: string): number {
  return fields.findIndex((f) => f.id === id);
}

function findFieldById(fields: FieldDefinition[], id: string): FieldDefinition | null {
  for (const f of fields) {
    if (f.id === id) return f;
    if ('children' in f && f.children) {
      const found = findFieldById(f.children, id);
      if (found) return found;
    }
  }
  return null;
}

function removeFieldById(fields: FieldDefinition[], id: string): FieldDefinition[] {
  return fields
    .filter((f) => f.id !== id)
    .map((f) => {
      if ('children' in f && f.children) {
        return { ...f, children: removeFieldById(f.children, id) } as FieldDefinition;
      }
      return f;
    });
}

function updateFieldById(
  fields: FieldDefinition[],
  id: string,
  updater: (f: FieldDefinition) => FieldDefinition,
): FieldDefinition[] {
  return fields.map((f) => {
    if (f.id === id) return updater(f);
    if ('children' in f && f.children) {
      return { ...f, children: updateFieldById(f.children, id, updater) } as FieldDefinition;
    }
    return f;
  });
}

/** Check whether a field (by id) lives inside a container field */
function isInsideContainer(fields: FieldDefinition[], id: string, depth = 0): boolean {
  for (const f of fields) {
    if (f.id === id) return depth > 0;
    if ('children' in f && f.children) {
      if (isInsideContainer(f.children, id, depth + 1)) return true;
    }
  }
  return false;
}

// ── Field factory ────────────────────────────────────────────────────────────

let _idCounter = 0;
function nextId(): string {
  return `field-${Date.now()}-${++_idCounter}`;
}

function createField(type: FieldType, existingKeys: Set<string>): FieldDefinition {
  const label = `Untitled ${FIELD_TYPE_LABELS[type]}`;
  const rawKey = labelToKey(label);
  const key = ensureUnique(rawKey, existingKeys);
  const id = nextId();

  if (type === 'section') {
    return { id, key, label, type: 'section', children: [] };
  }
  if (type === 'repeat') {
    return { id, key, label, type: 'repeat', required: false, children: [] };
  }
  if (type === 'select') {
    return { id, key, label, type: 'select', required: false, enumValues: ['Option 1', 'Option 2'] };
  }
  if (type === 'text') {
    return { id, key, label, type: 'text', required: false };
  }
  if (type === 'number') {
    return { id, key, label, type: 'number', required: false };
  }
  if (type === 'boolean') {
    return { id, key, label, type: 'boolean', required: false };
  }
  if (type === 'textarea') {
    return { id, key, label, type: 'textarea', required: false };
  }
  if (type === 'date') {
    return { id, key, label, type: 'date', required: false };
  }
  if (type === 'email') {
    return { id, key, label, type: 'email', required: false };
  }
  if (type === 'file') {
    return { id, key, label, type: 'file', required: false };
  }
  // fallback (unsupported — should not be reachable from palette)
  return { id, key, label, type: 'unsupported', required: false, jsonSchemaFragment: {} };
}

// ── Component ────────────────────────────────────────────────────────────────

export default function VisualBuilder({
  fields,
  onChange,
  selectedId,
  onSelect,
  hasPublishedVersions,
}: Props) {
  const [activeItem, setActiveItem] = useState<Active | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveItem(event.active);
  }, []);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveItem(null);
      const { active, over } = event;
      if (!over) return;

      const activeData = active.data.current as Record<string, unknown> | undefined;
      const overData = over.data.current as Record<string, unknown> | undefined;

      const source = activeData?.source as string | undefined;

      // ── Palette → Canvas: create new field ──────────────────────────────
      if (source === 'palette') {
        const fieldType = activeData?.fieldType as FieldType;
        if (!fieldType || fieldType === 'unsupported') return;

        // Determine if the drop target is a container (section/repeat) child zone
        // or the canvas root — for now we always insert at top level (canvas-root)
        // and prevent nesting containers into containers.
        const overField = overData?.field as FieldDefinition | undefined;
        const overIsContainer =
          overField?.type === 'section' || overField?.type === 'repeat';

        const isContainer = fieldType === 'section' || fieldType === 'repeat';

        // Prevent container inside container
        if (isContainer && overIsContainer) return;

        const existingKeys = collectKeys(fields);
        const newField = createField(fieldType, existingKeys);

        // Find drop position in flat top-level list
        const overIndex = findFieldIndex(fields, over.id as string);
        if (overIndex >= 0) {
          const next = [...fields];
          next.splice(overIndex, 0, newField);
          onChange(next);
        } else {
          // Dropped on canvas-root or unknown target → append
          onChange([...fields, newField]);
        }
        onSelect(newField.id);
        return;
      }

      // ── Canvas → Canvas: reorder ─────────────────────────────────────────
      if (source === 'canvas') {
        const activeField = activeData?.field as FieldDefinition | undefined;
        if (!activeField) return;

        const isContainer =
          activeField.type === 'section' || activeField.type === 'repeat';

        // Prevent container being dropped into another container
        if (isContainer) {
          const overField = overData?.field as FieldDefinition | undefined;
          const overIsInsideContainer = isInsideContainer(fields, over.id as string);
          const overIsContainer =
            overField?.type === 'section' || overField?.type === 'repeat';
          if (overIsContainer || overIsInsideContainer) return;
        }

        if (active.id === over.id) return;

        // Only handle flat top-level reorder for now
        const oldIndex = findFieldIndex(fields, active.id as string);
        const newIndex = findFieldIndex(fields, over.id as string);
        if (oldIndex >= 0 && newIndex >= 0) {
          onChange(arrayMove(fields, oldIndex, newIndex));
        }
      }
    },
    [fields, onChange, onSelect],
  );

  // Determine label for drag overlay
  let overlayLabel: string | null = null;
  if (activeItem) {
    const data = activeItem.data.current as Record<string, unknown> | undefined;
    if (data?.source === 'palette') {
      const ft = data.fieldType as FieldType;
      overlayLabel = FIELD_TYPE_LABELS[ft] ?? ft;
    } else if (data?.source === 'canvas') {
      const f = data.field as FieldDefinition | undefined;
      overlayLabel = f?.label || FIELD_TYPE_LABELS[f?.type ?? 'text'];
    }
  }

  // Selected field for PropertiesPanel
  const selectedField = selectedId ? findFieldById(fields, selectedId) : null;

  function handleDelete(id: string) {
    if (selectedId === id) onSelect(null);
    onChange(removeFieldById(fields, id));
  }

  function handleFieldChange(updated: FieldDefinition) {
    onChange(updateFieldById(fields, updated.id, () => updated));
  }

  return (
    <div className="visual-builder">
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        <FieldPalette />
        <FormCanvas
          fields={fields}
          selectedId={selectedId}
          onSelect={onSelect}
          onDelete={handleDelete}
        />
        <DragOverlay>
          {overlayLabel ? (
            <div className="drag-overlay-item">{overlayLabel}</div>
          ) : null}
        </DragOverlay>
      </DndContext>
      <PropertiesPanel
        field={selectedField}
        allFields={fields}
        hasPublishedVersions={hasPublishedVersions}
        onChange={handleFieldChange}
        onDelete={handleDelete}
      />
    </div>
  );
}
