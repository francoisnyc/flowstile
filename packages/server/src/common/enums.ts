export enum TaskStatus {
  CREATED = 'created',
  CLAIMED = 'claimed',
  COMPLETED = 'completed',
  CANCELLED = 'cancelled',
}

export enum Priority {
  LOW = 'low',
  NORMAL = 'normal',
  HIGH = 'high',
  URGENT = 'urgent',
}

export enum FormDefinitionStatus {
  DRAFT = 'draft',
  PUBLISHED = 'published',
}

export enum ProcessDefinitionStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
}

export enum UserStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
}

export enum SignalStatus {
  NOT_APPLICABLE = 'not_applicable',
  PENDING        = 'pending',
  DELIVERED      = 'delivered',
  FAILED         = 'failed',
}

export enum OutboxStatus {
  PENDING   = 'pending',
  DELIVERED = 'delivered',
  FAILED    = 'failed',
}

export enum OutcomeStyle {
  PRIMARY   = 'primary',
  SECONDARY = 'secondary',
  DANGER    = 'danger',
}

export enum AttachmentStatus {
  PENDING = 'pending',
  LINKED  = 'linked',
}

// Who performed a case-timeline event. Automated and agent work get their own
// honestly-labelled slot — never disguised as a human.
export enum CaseEventActor {
  HUMAN  = 'human',
  SYSTEM = 'system',
  AGENT  = 'agent',
}

export type PayloadScope = 'input' | 'context' | 'submission';
