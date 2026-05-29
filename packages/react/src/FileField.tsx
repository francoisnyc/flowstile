import React, { useRef, useState } from 'react';
import type { AttachmentRef, AttachmentFieldConfig } from './types.js';
import type { FlowstileClient } from './client.js';

interface Props {
  taskId: string;
  fieldKey: string;
  config: AttachmentFieldConfig;
  value: AttachmentRef | AttachmentRef[] | null | undefined;
  readOnly?: boolean;
  client: FlowstileClient;
  onChange: (next: AttachmentRef | AttachmentRef[] | null) => void;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function FileField({ taskId, fieldKey, config, value, readOnly, client, onChange }: Props) {
  const multiple = config.multiple ?? false;
  const refs: AttachmentRef[] = value == null
    ? []
    : Array.isArray(value) ? value : [value];

  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setError(null);
    setUploading(true);
    try {
      const uploaded: AttachmentRef[] = [];
      for (const file of Array.from(files)) {
        const ref = await client.uploadAttachment(taskId, file);
        uploaded.push(ref);
      }
      onChange(multiple ? [...refs, ...uploaded] : uploaded[0]);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setUploading(false);
    }
  };

  const remove = (attachmentId: string) => {
    if (multiple) {
      const next = refs.filter((r) => r.attachmentId !== attachmentId);
      onChange(next.length > 0 ? next : null);
    } else {
      onChange(null);
    }
  };

  return (
    <div className="flowstile-file-field" data-field-key={fieldKey}>
      {refs.map((ref) => (
        <div key={ref.attachmentId} className="flowstile-file-ref">
          <a
            href={client.getAttachmentUrl(taskId, ref.attachmentId)}
            target="_blank"
            rel="noreferrer"
            className="flowstile-file-name"
          >
            {ref.fileName}
          </a>
          <span className="flowstile-file-size">{formatBytes(ref.size)}</span>
          {!readOnly && (
            <button
              type="button"
              className="flowstile-file-remove"
              aria-label="Remove"
              onClick={() => remove(ref.attachmentId)}
            >
              ✕
            </button>
          )}
        </div>
      ))}
      {!readOnly && (multiple || refs.length === 0) && (
        <>
          <input
            ref={inputRef}
            type="file"
            accept={config.accept?.join(',') ?? undefined}
            multiple={multiple}
            style={{ display: 'none' }}
            onChange={(e) => handleFiles(e.target.files)}
          />
          <button
            type="button"
            className="flowstile-btn flowstile-btn--attach"
            disabled={uploading}
            onClick={() => inputRef.current?.click()}
          >
            {uploading ? 'Uploading…' : '+ Attach file'}
          </button>
        </>
      )}
      {error && <p className="flowstile-file-error">{error}</p>}
    </div>
  );
}
