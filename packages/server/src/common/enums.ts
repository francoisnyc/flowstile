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
