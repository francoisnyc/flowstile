import React, { useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { listTasks, getTask } from '../api/client.js';
import type { Task } from '../types.js';
import TaskList, { type Filter } from '../components/TaskList.js';
import TaskDetail from '../components/TaskDetail.js';

export default function InboxPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [filter, setFilter] = useState<Filter>('all');
  const [selected, setSelected] = useState<Task | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchTasks = useCallback(async () => {
    setLoading(true);
    try {
      // Fetch created + claimed (open tasks)
      const [created, claimed] = await Promise.all([
        listTasks({ status: 'created' }),
        listTasks({ status: 'claimed' }),
      ]);
      setTasks([...created.items, ...claimed.items]);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchTasks(); }, [fetchTasks]);

  // Deep-link: if ?task=<id> is present, select that task directly
  useEffect(() => {
    const taskId = searchParams.get('task');
    if (!taskId) return;
    // Clear the param so it doesn't re-trigger on navigation
    setSearchParams({}, { replace: true });
    getTask(taskId).then(setSelected).catch(console.error);
  }, [searchParams, setSearchParams]);

  const handleSelect = async (task: Task) => {
    try {
      const detail = await getTask(task.id);
      setSelected(detail);
    } catch (err) {
      console.error(err);
    }
  };

  const handleTaskUpdated = async (taskId: string) => {
    await fetchTasks();
    try {
      const detail = await getTask(taskId);
      setSelected(detail);
    } catch {
      setSelected(null);
    }
  };

  // Refresh only the selected task (e.g. a chat agent patched the draft), without
  // reloading — and flickering — the whole task list.
  const handleDraftRefresh = async (taskId: string) => {
    try {
      setSelected(await getTask(taskId));
    } catch {
      // transient — the next poll retries
    }
  };

  return (
    <div className="inbox">
      <TaskList
        tasks={tasks}
        loading={loading}
        filter={filter}
        onFilterChange={setFilter}
        selectedId={selected?.id}
        onSelect={handleSelect}
      />
      <TaskDetail task={selected} onTaskUpdated={handleTaskUpdated} onDraftRefresh={handleDraftRefresh} />
    </div>
  );
}
