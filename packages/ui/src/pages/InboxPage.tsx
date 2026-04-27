import React, { useState, useEffect, useCallback } from 'react';
import { listTasks, getTask } from '../api/client.js';
import type { Task } from '../types.js';
import TaskList, { type Filter } from '../components/TaskList.js';
import TaskDetail from '../components/TaskDetail.js';

export default function InboxPage() {
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
      setTasks([...created, ...claimed]);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchTasks(); }, [fetchTasks]);

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
      <TaskDetail task={selected} onTaskUpdated={handleTaskUpdated} />
    </div>
  );
}
