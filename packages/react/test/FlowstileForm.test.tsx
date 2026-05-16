import { describe, it, expect, vi } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import React from 'react';
import { FlowstileForm } from '../src/FlowstileForm.js';

const schema = {
  type: 'object',
  properties: {
    name: { type: 'string' },
  },
};

const uiSchema = {
  type: 'VerticalLayout',
  elements: [{ type: 'Control', scope: '#/properties/name' }],
};

/**
 * JSON Forms uses an internal Redux store. Triggering its onChange requires
 * calling the React fiber's memoizedProps.onChange and waiting for the store
 * to propagate to the outer onChange callback.
 */
function triggerJsonFormsChange(input: Element, value: string) {
  const fiberKey = Object.keys(input).find((k) => k.startsWith('__reactFiber'));
  if (!fiberKey) throw new Error('No React fiber found on input element');
  const fiber = (input as Record<string, unknown>)[fiberKey] as { memoizedProps?: { onChange?: (e: { target: { value: string } }) => void } };
  if (!fiber?.memoizedProps?.onChange) throw new Error('No onChange on fiber memoizedProps');
  fiber.memoizedProps.onChange({ target: { value } });
}

describe('FlowstileForm', () => {
  it('renders form fields from schema', () => {
    const { container } = render(
      <FlowstileForm
        schema={schema}
        uiSchema={uiSchema}
        data={{ name: '' }}
        onChange={() => {}}
      />,
    );

    // JSON Forms vanilla renderers may not use role="textbox"; query by tag
    const inputs = container.querySelectorAll('input');
    expect(inputs.length).toBeGreaterThan(0);
  });

  it('calls onChange when field value changes', async () => {
    const onChange = vi.fn();
    const { container } = render(
      <FlowstileForm
        schema={schema}
        uiSchema={uiSchema}
        data={{ name: '' }}
        onChange={onChange}
      />,
    );

    const input = container.querySelector('input')!;

    await act(async () => {
      triggerJsonFormsChange(input, 'Alice');
    });

    await waitFor(() => {
      expect(onChange).toHaveBeenCalled();
    });

    const calledWith = onChange.mock.calls[0][0] as Record<string, unknown>;
    expect(calledWith).toMatchObject({ name: 'Alice' });
  });

  it('renders as read-only when readOnly is true', () => {
    const { container } = render(
      <FlowstileForm
        schema={schema}
        uiSchema={uiSchema}
        data={{ name: 'Bob' }}
        onChange={() => {}}
        readOnly={true}
      />,
    );

    const inputs = container.querySelectorAll('input');
    // At least one input should be disabled or readonly
    const hasReadonlyOrDisabled = Array.from(inputs).some(
      (el) => (el as HTMLInputElement).disabled || (el as HTMLInputElement).readOnly,
    );
    expect(hasReadonlyOrDisabled).toBe(true);
  });

  it('displays validation errors when provided', () => {
    const validationErrors = {
      '/data/name': ['Name is required'],
      '/data/email': ['Invalid email format'],
    };

    render(
      <FlowstileForm
        schema={schema}
        uiSchema={uiSchema}
        data={{ name: '' }}
        onChange={() => {}}
        validationErrors={validationErrors}
      />,
    );

    const alert = screen.getByRole('alert');
    expect(alert).toBeDefined();
    expect(alert.textContent).toContain('Name is required');
    expect(alert.textContent).toContain('Invalid email format');
  });
});
