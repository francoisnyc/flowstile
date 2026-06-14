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
 * The server-side snapshot the doctor's decision logic compares against. This
 * is the seam between the imperative shell (`runDoctor`, which fetches) and the
 * pure core (`evaluateProcessHealth`, which decides) — mirroring how
 * `deriveMilestoneStates` keeps milestone logic pure and the route does I/O.
 */
export interface DoctorSnapshot {
  /** The server's process definition, or null if no process matches by name. */
  process: ServerProcess | null;
  /** Task definitions registered under the process (empty if process is null). */
  taskDefs: ServerTaskDef[];
  /** Form codes that have at least one published version. */
  publishedFormCodes: Set<string>;
}

/**
 * Pure decision core: given a worker's process declaration and a snapshot of
 * the server, produce the findings. No I/O — every branch is a unit test.
 *
 * Checks:
 * - the process exists on the server (missing → error, short-circuits)
 * - queue / workflowType are configured and consistent
 * - every `defineTask` code exists as a server task definition
 * - declared phases agree with server milestoneCodes
 * - the declared plan matches the server's milestones (order-sensitive)
 * - every server task's milestoneCode resolves to a server milestone
 *   (catches direct-write/seed drift the POST/PATCH 422 never sees)
 * - every referenced form has a published version
 */
export function evaluateProcessHealth(
  proc: ProcessDefinition,
  snapshot: DoctorSnapshot,
): DoctorReport {
  const findings: DoctorFinding[] = [];
  const error = (check: string, detail: string) => findings.push({ severity: 'error', check, detail });
  const warn = (check: string, detail: string) => findings.push({ severity: 'warn', check, detail });
  const ok = (check: string, detail: string) => findings.push({ severity: 'ok', check, detail });

  // 1. The process definition exists on the server
  const serverProc = snapshot.process;
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
  const byCode = new Map(snapshot.taskDefs.map((td) => [td.code, td]));
  const referencedFormCodes = new Set<string>();

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
    referencedFormCodes.add(td.formDefinitionCode);
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
  const serverMilestoneCodes = (serverProc.milestones ?? []).map((m) => m.code);
  const codePlan = [...proc.plan];
  if (codePlan.length && JSON.stringify(serverMilestoneCodes) !== JSON.stringify(codePlan)) {
    warn(
      'plan',
      `Plan drift: code declares [${codePlan.join(' → ')}], server has ` +
        `[${serverMilestoneCodes.join(' → ') || '(none)'}]. The case stepper follows the server.`,
    );
  } else if (codePlan.length) {
    ok('plan', codePlan.join(' → '));
  }

  // 5. Intra-server consistency: every server task's milestoneCode must resolve
  // to a server milestone. The POST/PATCH 422 enforces this at write time, but
  // the seed script and any direct DB write bypass that route — and a dangling
  // milestoneCode fails silently (the stepper derivation renders the task
  // unphased), so the doctor is the only place this surfaces.
  const milestoneCodeSet = new Set(serverMilestoneCodes);
  for (const td of snapshot.taskDefs) {
    if (td.milestoneCode !== null && !milestoneCodeSet.has(td.milestoneCode)) {
      error(
        `milestone:${td.code}`,
        `Task definition '${td.code}' references milestone '${td.milestoneCode}', ` +
          `which is not in the server's plan [${serverMilestoneCodes.join(', ') || '(none)'}]. ` +
          `Its tasks will render unphased on the stepper. Fix the seed or the plan.`,
      );
    }
  }

  // 6. Every referenced form has a published version
  for (const code of referencedFormCodes) {
    if (snapshot.publishedFormCodes.has(code)) {
      ok(`form:${code}`, 'published version found');
    } else {
      error(
        `form:${code}`,
        `No published version of form '${code}' — tasks using it will fail to create (422). ` +
          `Design and publish it in the form designer.`,
      );
    }
  }

  return { ok: !findings.some((f) => f.severity === 'error'), findings };
}

/**
 * Preflight: validates this worker's process declaration against the server
 * before accepting work. Catches the seams that otherwise fail at runtime,
 * minutes later, in the Temporal UI. The imperative shell — fetches the
 * snapshot, then delegates every decision to `evaluateProcessHealth`.
 *
 * Pure read-only — never mutates the server.
 */
export async function runDoctor(
  flowstile: FlowstileClientOptions,
  proc: ProcessDefinition,
): Promise<DoctorReport> {
  const client = new FlowstileClient(flowstile);

  // The process definition, by name
  const processes = await client.get<Paginated<ServerProcess>>('/processes?limit=200');
  const serverProc = processes.items.find((p) => p.name === proc.name) ?? null;

  if (!serverProc) {
    return evaluateProcessHealth(proc, { process: null, taskDefs: [], publishedFormCodes: new Set() });
  }

  // Its task definitions
  const taskDefsPage = await client.get<Paginated<ServerTaskDef>>(
    `/processes/${serverProc.id}/tasks?limit=200`,
  );
  const taskDefs = taskDefsPage.items;

  // Which referenced forms have a published version. Resolve per unique code;
  // a 404 means "no published version" (recorded as not-published), any other
  // error propagates — the worker's try/catch treats that as "doctor couldn't
  // run, boot anyway" (fail-open on doctor infrastructure errors).
  const referenced = new Set(taskDefs.map((td) => td.formDefinitionCode));
  const publishedFormCodes = new Set<string>();
  for (const code of referenced) {
    try {
      await client.get(`/forms/${encodeURIComponent(code)}`);
      publishedFormCodes.add(code);
    } catch (err) {
      if (!(err instanceof FlowstileApiError && err.statusCode === 404)) throw err;
    }
  }

  return evaluateProcessHealth(proc, { process: serverProc, taskDefs, publishedFormCodes });
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
