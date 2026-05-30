#!/usr/bin/env node
/**
 * flowstile-codegen — generates typed process files from live form schemas.
 *
 * Usage:
 *   flowstile-codegen --process "Order Fulfillment" --task-queue flowstile
 *   flowstile-codegen --process "Order Fulfillment" --task-queue flowstile --out src/generated/process.ts
 *
 * Options:
 *   --url          Flowstile server URL (default: FLOWSTILE_URL env, then http://localhost:3000)
 *   --api-key      API key (default: FLOWSTILE_API_KEY env)
 *   --email        Email for password auth (fallback when no API key)
 *   --password     Password for password auth
 *   --process      Process name to generate for (required)
 *   --task-queue   Temporal task queue name (required)
 *   --out          Output file path (default: ./generated/<process-slug>.ts)
 *   --help         Show this help
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { generateProcessFile, toCamelCase } from './schema-to-ts.js';
import { FlowstileApiError } from './errors.js';

// ---------------------------------------------------------------------------
// Arg parsing (no external library needed for this simple CLI)
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const result: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        result[key] = true;
      } else {
        result[key] = next;
        i++;
      }
    }
  }
  return result;
}

const args = parseArgs(process.argv.slice(2));

if (args['help']) {
  console.log((import.meta as { url: string }).url.includes('flowstile-codegen')
    ? 'flowstile-codegen' : 'Usage');
  console.log(`
flowstile-codegen [options]

Options:
  --url         Flowstile server URL (default: $FLOWSTILE_URL or http://localhost:3000)
  --api-key     API key (default: $FLOWSTILE_API_KEY)
  --email       Email for password auth (fallback)
  --password    Password for password auth
  --process     Process name to generate for (required)
  --task-queue  Temporal task queue name (required)
  --out         Output file path (default: ./generated/<slug>.ts)
  --help        Show this message
`.trim());
  process.exit(0);
}

const baseUrl = (args['url'] as string | undefined) ?? process.env['FLOWSTILE_URL'] ?? 'http://localhost:3000';
const apiKey = (args['api-key'] as string | undefined) ?? process.env['FLOWSTILE_API_KEY'];
const email = (args['email'] as string | undefined) ?? process.env['FLOWSTILE_EMAIL'];
const password = (args['password'] as string | undefined) ?? process.env['FLOWSTILE_PASSWORD'];
const processName = args['process'] as string | undefined;
const taskQueue = args['task-queue'] as string | undefined;
const outPath = args['out'] as string | undefined;

// Secrets passed as flags are visible in shell history and the process table.
// Prefer the environment variables; warn when a flag is used instead.
if (args['api-key'] || args['password']) {
  console.warn(
    'Warning: passing secrets via --api-key/--password exposes them in shell history and `ps`. ' +
    'Prefer FLOWSTILE_API_KEY / FLOWSTILE_PASSWORD environment variables.',
  );
}

if (!processName) {
  console.error('Error: --process is required');
  process.exit(1);
}
if (!taskQueue) {
  console.error('Error: --task-queue is required');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function getAuthHeader(): Promise<string> {
  if (apiKey) return `Bearer ${apiKey}`;

  if (email && password) {
    const res = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) throw new FlowstileApiError(res.status, '/auth/login', await res.text());
    const cookie = res.headers.get('set-cookie') ?? '';
    const match = cookie.match(/flowstile_token=([^;]+)/);
    if (!match) throw new Error('Login succeeded but no token in Set-Cookie');
    return `Bearer ${match[1]}`;
  }

  // No credentials — try unauthenticated (will likely 401)
  return '';
}

async function apiFetch<T>(path: string, authHeader: string): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
  });
  if (!res.ok) throw new FlowstileApiError(res.status, path, await res.text());
  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

interface ProcessItem { id: string; name: string }
interface TaskDefItem { id: string; code: string; formDefinitionCode: string; defaultPriority: string }
interface FormItem { code: string; version: number; jsonSchema: Record<string, unknown> }

async function run() {
  console.log(`\nFlowstile codegen`);
  console.log(`  Server:  ${baseUrl}`);
  console.log(`  Process: ${processName}\n`);

  const auth = await getAuthHeader();

  // 1. Find process by name
  const allProcesses = await apiFetch<{ items: ProcessItem[] }>('/processes?limit=200', auth);
  const proc = allProcesses.items.find(
    (p) => p.name.toLowerCase() === processName!.toLowerCase(),
  );
  if (!proc) {
    const names = allProcesses.items.map((p) => `  • ${p.name}`).join('\n');
    console.error(`Error: Process "${processName}" not found. Available processes:\n${names || '  (none)'}`);
    process.exit(1);
  }

  // 2. Fetch task definitions for this process
  const taskDefs = await apiFetch<{ items: TaskDefItem[] }>(
    `/processes/${proc.id}/tasks?limit=200`,
    auth,
  );
  if (taskDefs.items.length === 0) {
    console.error(`Error: Process "${processName}" has no task definitions.`);
    process.exit(1);
  }

  console.log(`  Found ${taskDefs.items.length} task definition(s):`);
  for (const td of taskDefs.items) {
    console.log(`    ${td.code} → form: ${td.formDefinitionCode}`);
  }

  // 3. Fetch form schemas (deduplicate by code)
  const formCodes = [...new Set(taskDefs.items.map((td) => td.formDefinitionCode))];
  const formMap = new Map<string, FormItem>();

  for (const code of formCodes) {
    try {
      const form = await apiFetch<FormItem>(`/forms/${code}`, auth);
      formMap.set(code, form);
    } catch (err) {
      console.warn(`  Warning: could not fetch form "${code}" — ${err instanceof Error ? err.message : err}`);
    }
  }

  // 4. Generate the file
  const output = generateProcessFile({
    processName: processName!,
    taskQueue: taskQueue!,
    tasks: taskDefs.items.map((td) => ({
      code: td.code,
      formCode: td.formDefinitionCode,
      defaultPriority: td.defaultPriority,
    })),
    forms: formMap,
    serverUrl: baseUrl,
  });

  // 5. Write to disk
  const slug = toCamelCase(processName!.replace(/\s+/g, '_'));
  const resolvedOut = outPath ?? `./generated/${slug}.ts`;
  mkdirSync(dirname(resolvedOut), { recursive: true });
  writeFileSync(resolvedOut, output, 'utf-8');

  console.log(`\n✓ Written to ${resolvedOut}`);
  console.log(`\nTo use it:\n`);
  console.log(`  import { ${slug}Process } from './${resolvedOut.replace(/\.ts$/, '.js').replace(/^\.\//, '')}';`);
  console.log(`  // then use ${slug}Process.tasks.<taskName>.createAndWait({ ... })\n`);
}

run().catch((err) => {
  console.error('\nCodegen failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
