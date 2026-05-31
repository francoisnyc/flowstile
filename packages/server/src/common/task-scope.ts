import type { SelectQueryBuilder } from 'typeorm';
import type { AuthPrincipal } from '../plugins/auth.js';
import type { Task } from '../entities/task.entity.js';
import { Permissions } from './permissions.js';

// Need-to-know access scoping for tasks and cases.
//
// Two tiers, mirroring Camunda: a coarse permission tier (tasks:read — can you
// use the inbox at all) and an instance tier enforced here. A non-oversight
// human sees a task only when they are its assignee, a candidate user (by
// email), or a member of a candidate group (by name). Strict by design: a task
// with no candidates and no assignee is visible only to oversight.

// True when the principal bypasses instance scoping entirely: the workflow
// engine (service credential) and human supervisors holding tasks:manage.
export function principalSeesAllTasks(principal: AuthPrincipal): boolean {
  return principal.kind === 'service' || principal.permissions.includes(Permissions.TASKS_MANAGE);
}

// True when the principal may see every case: the engine, supervisors with
// tasks:manage, or anyone granted the cases:read oversight permission.
export function principalSeesAllCases(principal: AuthPrincipal): boolean {
  return (
    principal.kind === 'service' ||
    principal.permissions.includes(Permissions.TASKS_MANAGE) ||
    principal.permissions.includes(Permissions.CASES_READ)
  );
}

// The (email, groupNames) identity a scope check matches a task's candidates
// against. Derived from the human User behind the principal.
function identity(principal: AuthPrincipal): { userId: string; email: string; groupNames: string[] } | null {
  if (!principal.user) return null;
  return {
    userId: principal.user.id,
    email: principal.user.email,
    groupNames: principal.user.groups?.map((g) => g.name) ?? [],
  };
}

// Narrows a task query to the rows a non-oversight principal may read. A no-op
// for oversight principals. The alias defaults to the conventional 't'.
export function applyTaskScope(
  qb: SelectQueryBuilder<Task>,
  principal: AuthPrincipal,
  alias = 't',
): void {
  if (principalSeesAllTasks(principal)) return;
  const id = identity(principal);
  if (!id) {
    // Authenticated but not a human and not oversight — see nothing.
    qb.andWhere('1 = 0');
    return;
  }
  qb.andWhere(
    `(${alias}.assigneeId = :scopeUserId
      OR :scopeEmail = ANY(${alias}.candidateUsers)
      OR ${alias}.candidateGroups && :scopeGroups::text[])`,
    { scopeUserId: id.userId, scopeEmail: id.email, scopeGroups: id.groupNames },
  );
}

// In-memory equivalent of applyTaskScope for tasks already loaded (task detail,
// case-involvement checks).
export function canSeeTask(task: Task, principal: AuthPrincipal): boolean {
  if (principalSeesAllTasks(principal)) return true;
  const id = identity(principal);
  if (!id) return false;
  return (
    task.assigneeId === id.userId ||
    task.candidateUsers.includes(id.email) ||
    task.candidateGroups.some((g) => id.groupNames.includes(g))
  );
}

// A principal may read a case if they can see all cases, started it, or can see
// at least one of its tasks (case scope derives from task scope — one rule).
export function canSeeCase(
  caseStartedById: string | null,
  tasks: Task[],
  principal: AuthPrincipal,
): boolean {
  if (principalSeesAllCases(principal)) return true;
  if (caseStartedById && principal.user && caseStartedById === principal.user.id) return true;
  return tasks.some((t) => canSeeTask(t, principal));
}
