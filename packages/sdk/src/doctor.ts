import { FlowstileClient } from './client.js';
import { FlowstileApiError } from './errors.js';
import type { FlowstileClientOptions, Paginated } from './types.js';
import type { ProcessDefinition } from './process.js';

export type DoctorSeverity = 'error' | 'warn' | 'ok';

export interface DoctorFinding {
  severity: DoctorSeverity;
  check: string;
  detail: string;
}

export interface DoctorReport {
  ok: boolean;
  findings: DoctorFinding[];
}

interface ServerProcess {
  id: string;
  name: string;
  workflowType: string | null;
  taskQueue: string | null;
  milestones: { code: string; name: string }[] | null;
}

interface ServerTaskDef {
  id: string;
  code: string;
  formDefinitionCode: string;
  milestoneCode: string | null;
}

/**
 * Preflight: validates this worker's process declaration against the server
 * before accepting work. Catches the seams that otherwise fail at runtime,
 * minutes later, in the Temporal UI:
 *
 * - every `defineTask` code exists as a task definition on the server
 * - every task definition's form has a published version
 * - the process's workflowType / taskQueue are configured and consistent
 * - the declared plan and phases match the server's milestones (warn-only)
 *
 * Pure read-only — never mutates the server.
 */
export async function runDoctor(
  flowstile: FlowstileClientOptions,
  proc: ProcessDefinition,
): Promise<DoctorReport> {
  const client = new FlowstileClient(flowstile);
  const findings: DoctorFinding[] = [];
  const error = (check: string, detail: string) => findings.push({ severity: 'error', check, detail });
  const warn = (check: string, detail: string) => findings.push({ severity: 'warn', check, detail });
  const ok = (check: string, detail: string) => findings.push({ severity: 'ok', check, detail });

  // 1. The process definition exists on the server
  const processes = await client.get<Paginated<ServerProcess>>('/processes?limit=200');
  const serverProc = processes.items.find((p) => p.name === proc.name);
  if (!serverProc) {
    error(
      'process',
      `No process definition named '${proc.name}' on the server. ` +
        `Create it (POST /processes) or check the name in defineProcess.`,
    );
    return { ok: false, findings };
  }
  ok('process', `'${proc.name}' found (${serverProc.id})`);

  // 2. Queue + workflow type configuration
  if (serverProc.taskQueue && serverProc.taskQueue !== proc.taskQueue) {
    error(
      'taskQueue',
      `Worker registers on '${proc.taskQueue}' but the server starts workflows on ` +
        `'${serverProc.taskQueue}' — portal-started cases will hang.`,
    );
  } else if (!serverProc.taskQueue) {
    warn('taskQueue', `Server has no taskQueue set — portal start disabled for this process.`);
  } else {
    ok('taskQueue', proc.taskQueue);
  }
  if (!serverProc.workflowType) {
    warn('workflowType', 'Server has no workflowType set — portal start disabled for this process.');
  }

  // 3. Every declared task code exists; phases agree with server milestones
  const taskDefs = await client.get<Paginated<ServerTaskDef>>(
    `/processes/${serverProc.id}/tasks?limit=200`,
  );
  const byCode = new Map(taskDefs.items.map((td) => [td.code, td]));
  const formCodes = new Set<string>();

  for (const [key, descriptor] of Object.entries(proc.tasks)) {
    const td = byCode.get(descriptor.taskDefinitionCode);
    if (!td) {
      const known = [...byCode.keys()];
      const hint = closestMatch(descriptor.taskDefinitionCode, known);
      error(
        `task:${key}`,
        `Task definition '${descriptor.taskDefinitionCode}' not found on the server.` +
          (hint ? ` Did you mean '${hint}'?` : '') +
          ` Known codes: ${known.join(', ') || '(none)'}`,
      );
      continue;
    }
    formCodes.add(td.formDefinitionCode);
    if ((td.milestoneCode ?? null) !== descriptor.phase) {
      warn(
        `task:${key}`,
        `Phase mismatch for '${td.code}': code declares '${descriptor.phase}', ` +
          `server has '${td.milestoneCode}'. The case stepper follows the server.`,
      );
    } else {
      ok(`task:${key}`, `${td.code} → ${descriptor.phase ?? '(unphased)'}`);
    }
  }

  // 4. Plan vs server milestones (order-sensitive)
  const serverPlan = (serverProc.milestones ?? []).map((m) => m.code);
  const codePlan = [...proc.plan];
  if (codePlan.length && JSON.stringify(serverPlan) !== JSON.stringify(codePlan)) {
    warn(
      'plan',
      `Plan drift: code declares [${codePlan.join(' → ')}], server has ` +
        `[${serverPlan.join(' → ') || '(none)'}]. The case stepper follows the server.`,
    );
  } else if (codePlan.length) {
    ok('plan', codePlan.join(' → '));
  }

  // 5. Every referenced form has a published version
  for (const code of formCodes) {
    try {
      await client.get(`/forms/${encodeURIComponent(code)}`);
      ok(`form:${code}`, 'published version found');
    } catch (err) {
      if (err instanceof FlowstileApiError && err.statusCode === 404) {
        error(
          `form:${code}`,
          `No published version of form '${code}' — tasks using it will fail to create (422). ` +
            `Design and publish it in the form designer.`,
        );
      } else {
        throw err;
      }
    }
  }

  return { ok: !findings.some((f) => f.severity === 'error'), findings };
}

/** Render a doctor report for terminal output. */
export function formatDoctorReport(report: DoctorReport): string {
  const icon = { ok: '✓', warn: '⚠', error: '✗' } as const;
  const lines = report.findings.map((f) => `  ${icon[f.severity]} ${f.check.padEnd(24)} ${f.detail}`);
  return ['Flowstile doctor:', ...lines].join('\n');
}

// Smallest Levenshtein distance ≤ 3 wins — enough for typo'd task codes
// without dragging in a dependency.
function closestMatch(input: string, candidates: string[]): string | null {
  let best: string | null = null;
  let bestDist = 4;
  for (const candidate of candidates) {
    const d = levenshtein(input, candidate);
    if (d < bestDist) {
      bestDist = d;
      best = candidate;
    }
  }
  return best;
}

function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return dp[a.length][b.length];
}
