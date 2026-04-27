import { FlowstileClient } from './client.js';
import type { CreateTaskInput, Task } from './types.js';

let _client: FlowstileClient | null = null;

/**
 * Call this once when starting your Temporal worker, before registering activities.
 *
 * Example:
 *   import { configureFlowstileActivities } from '@flowstile/sdk/activities';
 *   configureFlowstileActivities('http://flowstile-server:3000');
 */
export function configureFlowstileActivities(baseUrl: string): void {
  _client = new FlowstileClient({ baseUrl });
}

function client(): FlowstileClient {
  if (!_client) {
    throw new Error(
      'Flowstile activities are not configured. Call configureFlowstileActivities(baseUrl) before starting your worker.',
    );
  }
  return _client;
}

export async function createFlowstileTask(input: CreateTaskInput): Promise<Task> {
  return client().createTask(input);
}

export async function getFlowstileTask(taskId: string): Promise<Task> {
  return client().getTask(taskId);
}

export async function cancelFlowstileTask(taskId: string): Promise<Task> {
  return client().cancelTask(taskId);
}
