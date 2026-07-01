import React, { useState, useEffect, useRef, useCallback } from 'react';
import type { Task, TaskMessage } from '../types.js';
import { listMessages, postMessage } from '../api/client.js';

interface Props {
  task: Task;
  // Called when the agent has replied, so the parent can refetch the task and
  // the draft form reflects the agent's latest patch.
  onAgentReplied: () => void;
  disabled: boolean;
}

// The conversation surface for a chat task: renders the transcript and lets the
// human reply. The agent's replies + draft updates arrive via polling.
export default function ChatPanel({ task, onAgentReplied, disabled }: Props) {
  const [messages, setMessages] = useState<TaskMessage[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const countRef = useRef(0);

  const refresh = useCallback(async () => {
    try {
      const { items } = await listMessages(task.id);
      // If a new agent message arrived since last poll, refresh the draft form.
      const grew = items.length > countRef.current;
      const lastIsAgent = items.length > 0 && items[items.length - 1].role === 'agent';
      countRef.current = items.length;
      setMessages(items);
      if (grew && lastIsAgent) onAgentReplied();
    } catch {
      // transient — the next poll retries
    }
  }, [task.id, onAgentReplied]);

  useEffect(() => {
    countRef.current = 0;
    refresh();
    const timer = setInterval(refresh, 1500);
    return () => clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  const send = async () => {
    const content = input.trim();
    if (!content || busy) return;
    setBusy(true);
    try {
      await postMessage(task.id, content);
      setInput('');
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="chat-panel" data-testid="chat-panel">
      <div className="chat-messages">
        {messages.map((m) => (
          <div key={m.id} className={`chat-bubble ${m.role}`} data-testid={`chat-${m.role}`}>
            <span className="chat-role">{m.role === 'agent' ? 'Agent' : 'You'}</span>
            <div className="chat-content">{m.content}</div>
          </div>
        ))}
        <div ref={endRef} />
      </div>
      <div className="chat-input">
        <textarea
          className="chat-textarea"
          placeholder={disabled ? 'Claim the task to reply…' : 'Type your reply…'}
          value={input}
          disabled={disabled || busy}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          data-testid="chat-textarea"
        />
        <button className="primary" onClick={send} disabled={disabled || busy || !input.trim()} data-testid="chat-send">
          Send
        </button>
      </div>
    </div>
  );
}
