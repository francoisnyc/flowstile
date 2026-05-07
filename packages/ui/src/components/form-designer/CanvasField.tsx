import React from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { FieldDefinition } from './types.js';
import { FIELD_TYPE_LABELS } from './types.js';

interface Props {
  field: FieldDefinition;
  isSelected: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  depth: number;
}

export default function CanvasField({ field, isSelected, selectedId, onSelect, onDelete, depth }: Props) {
  const {
    attributes, listeners, setNodeRef, transform, transition, isDragging,
  } = useSortable({ id: field.id, data: { source: 'canvas', field } });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };

  const isContainer = field.type === 'section' || field.type === 'repeat';

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`canvas-field ${isSelected ? 'selected' : ''} ${isContainer ? 'container' : ''}`}
      onClick={(e) => { e.stopPropagation(); onSelect(field.id); }}
    >
      <div className="canvas-field-header">
        <span className="drag-handle" {...attributes} {...listeners}>⠿</span>
        <span className="field-type-badge">{FIELD_TYPE_LABELS[field.type]}</span>
        <span className="field-label">{field.label || 'Untitled'}</span>
        {'required' in field && field.required && <span className="required-badge">REQ</span>}
        <span className="field-key">{field.key}</span>
        <button
          className="delete-btn"
          onClick={(e) => { e.stopPropagation(); onDelete(field.id); }}
          title="Delete field"
        >×</button>
      </div>
      {isContainer && 'children' in field && (
        <div className="canvas-children">
          {field.children.length === 0 ? (
            <div className="canvas-drop-hint">Drop fields here</div>
          ) : (
            field.children.map((child) => (
              <CanvasField
                key={child.id}
                field={child}
                isSelected={child.id === selectedId}
                selectedId={selectedId}
                onSelect={onSelect}
                onDelete={onDelete}
                depth={depth + 1}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}
