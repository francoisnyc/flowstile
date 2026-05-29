import React, { useRef, useState } from 'react';
import type { AttachmentRef, AttachmentFieldConfig } from '../types.js';
import { uploadAttachment, getAttachmentUrl } from '../api/client.js';

interface Props {
  taskId: string;
  fieldKey: string;
  config: AttachmentFieldConfig;
  value: AttachmentRef | AttachmentRef[] | null | undefined;
  readOnly?: boolean;
  onChange: (next: AttachmentRef | AttachmentRef[] | null) => void;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export default function FileField({ taskId, fieldKey, config, value, readOnly, onChange }: Props) {
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
        const ref = await uploadAttachment(taskId, file);
        uploaded.push(ref);
      }
      if (multiple) {
        onChange([...refs, ...uploaded]);
      } else {
        onChange(uploaded[0]);
      }
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

  const acceptStr = config.accept?.join(',') ?? undefined;

  return (
    <div className="file-field" data-field-key={fieldKey}>
      {refs.map((ref) => (
        <div key={ref.attachmentId} className="file-ref" style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <a
            href={getAttachmentUrl(taskId, ref.attachmentId)}
            target="_blank"
            rel="noreferrer"
            style={{ flex: 1 }}
          >
            {ref.fileName}
          </a>
          <span className="muted" style={{ fontSize: 12 }}>{formatBytes(ref.size)}</span>
          {!readOnly && (
            <button
              type="button"
              className="icon-btn"
              title="Remove"
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
            accept={acceptStr}
            multiple={multiple}
            style={{ display: 'none' }}
            onChange={(e) => handleFiles(e.target.files)}
          />
          <button
            type="button"
            className="secondary"
            disabled={uploading}
            onClick={() => inputRef.current?.click()}
          >
            {uploading ? 'Uploading…' : '+ Attach file'}
          </button>
        </>
      )}
      {error && <p className="error" style={{ margin: '4px 0 0', fontSize: 13 }}>{error}</p>}
    </div>
  );
}
