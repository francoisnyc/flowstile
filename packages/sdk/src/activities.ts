import { FlowstileClient } from './client.js';
import type { CreateTaskInput, Task, FlowstileClientOptions } from './types.js';

let _client: FlowstileClient | null = null;

/**
 * Call this once when starting your Temporal worker, before registering activities.
 *
 * Example:
 *   import { configureFlowstileActivities } from '@flowstile/sdk/activities';
 *   configureFlowstileActivities({
 *     baseUrl: 'http://localhost:3000',
 *     auth: { email: 'service@flowstile.local', password: 'password' },
 *   });
 */
export function configureFlowstileActivities(options: FlowstileClientOptions): void {
  _client = new FlowstileClient(options);
}

function client(): FlowstileClient {
  if (!_client) {
    throw new Error(
      'Flowstile activities are not configured. Call configureFlowstileActivities(options) before starting your worker.',
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
