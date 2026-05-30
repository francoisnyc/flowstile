import { FlowstileClient } from './client.js';
import type {
  CreateTaskInput,
  Task,
  FlowstileClientOptions,
  CaseEntityResult,
  JsonPatchOperation,
} from './types.js';

let _client: FlowstileClient | null = null;

/**
 * Call this once when starting your Temporal worker, before registering activities.
 *
 * Example:
 *   import { configureFlowstileActivities } from '@flowstile/sdk/activities';
 *   configureFlowstileActivities({
 *     baseUrl: 'http://localhost:3000',
 *     apiKey: process.env.FLOWSTILE_API_KEY, // service credential — preferred for workers
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

// Reads back the authoritative case entity and its version. Call from a workflow
// (via proxyActivities) to retrieve cross-task business data — including from a
// patched-in or parallel branch that never received the data via local variables.
export async function getFlowstileCaseEntity(
  processInstanceId: string,
): Promise<CaseEntityResult> {
  return client().getCaseEntity(processInstanceId);
}

// Applies an RFC 6902 JSON Patch to the case entity. Disjoint-field patches from
// concurrent branches do not conflict (applied server-side under a row lock).
// Pass expectedVersion for optimistic concurrency on same-field updates.
export async function patchFlowstileCaseEntity(
  processInstanceId: string,
  patch: JsonPatchOperation[],
  expectedVersion?: number,
): Promise<CaseEntityResult> {
  return client().patchCaseEntity(processInstanceId, patch, expectedVersion);
}

// Replaces the entire case entity — for initialization or migration. Prefer
// patchFlowstileCaseEntity for incremental updates.
export async function setFlowstileCaseEntity(
  processInstanceId: string,
  entity: Record<string, unknown>,
): Promise<CaseEntityResult> {
  return client().setCaseEntity(processInstanceId, entity);
}

/** @deprecated Use setFlowstileCaseEntity or patchFlowstileCaseEntity. */
export async function setFlowstileCaseVariables(
  processInstanceId: string,
  variables: Record<string, unknown>,
): Promise<void> {
  await client().setCaseEntity(processInstanceId, variables);
}
