import React from 'react';
import { useDraggable } from '@dnd-kit/core';
import type { FieldType } from './types.js';
import { FIELD_TYPE_LABELS } from './types.js';

const PALETTE_ITEMS: { type: FieldType; icon: string }[] = [
  { type: 'text', icon: 'Aa' },
  { type: 'number', icon: '#' },
  { type: 'boolean', icon: '☑' },
  { type: 'select', icon: '▾' },
  { type: 'textarea', icon: '¶' },
  { type: 'date', icon: '📅' },
  { type: 'email', icon: '@' },
  { type: 'section', icon: '⊞' },
  { type: 'repeat', icon: '⟳' },
];

function PaletteItem({ type, icon }: { type: FieldType; icon: string }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `palette-${type}`,
    data: { source: 'palette', fieldType: type },
  });

  return (
    <div
      ref={setNodeRef}
      className={`palette-item ${isDragging ? 'dragging' : ''}`}
      {...listeners}
      {...attributes}
    >
      <span className="palette-icon">{icon}</span>
      <span>{FIELD_TYPE_LABELS[type]}</span>
    </div>
  );
}

export default function FieldPalette() {
  return (
    <div className="field-palette">
      <div className="palette-header">Field Types</div>
      <div className="palette-items">
        {PALETTE_ITEMS.map(({ type, icon }) => (
          <PaletteItem key={type} type={type} icon={icon} />
        ))}
      </div>
    </div>
  );
}
