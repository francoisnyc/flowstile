import React from 'react';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { useDroppable } from '@dnd-kit/core';
import type { FieldDefinition } from './types.js';
import CanvasField from './CanvasField.js';

interface Props {
  fields: FieldDefinition[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onDelete: (id: string) => void;
}

export default function FormCanvas({ fields, selectedId, onSelect, onDelete }: Props) {
  const { setNodeRef, isOver } = useDroppable({ id: 'canvas-root' });
  const ids = fields.map((f) => f.id);

  return (
    <div
      ref={setNodeRef}
      className={`form-canvas ${isOver ? 'drag-over' : ''}`}
      onClick={() => onSelect(null)}
    >
      <div className="canvas-header">Form Canvas</div>
      <div className="canvas-body">
        {fields.length === 0 ? (
          <div className="canvas-empty">
            Drag fields from the palette to start building your form
          </div>
        ) : (
          <SortableContext items={ids} strategy={verticalListSortingStrategy}>
            {fields.map((field) => (
              <CanvasField
                key={field.id}
                field={field}
                isSelected={field.id === selectedId}
                selectedId={selectedId}
                onSelect={onSelect}
                onDelete={onDelete}
                depth={0}
              />
            ))}
          </SortableContext>
        )}
      </div>
    </div>
  );
}
