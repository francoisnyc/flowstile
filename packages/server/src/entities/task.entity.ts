import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { TaskStatus, Priority, SignalStatus } from '../common/enums.js';
import { TaskDefinition } from './task-definition.entity.js';
import { User } from './user.entity.js';

@Entity('tasks')
@Index('idx_task_status', ['status'])
@Index('idx_task_assignee', ['assigneeId'])
@Index('idx_task_status_assignee', ['status', 'assigneeId'])
export class Task {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // Nullable: an ad-hoc task carries its own inline form (inlineFormSchema) and
  // has no task definition. A definition-backed task still sets both.
  @ManyToOne(() => TaskDefinition, { nullable: true })
  @JoinColumn({ name: 'task_definition_id' })
  taskDefinition: TaskDefinition | null;

  @Column({ type: 'uuid', name: 'task_definition_id', nullable: true })
  taskDefinitionId: string | null;

  // Null whenever the task uses an inline form (the inline schema *is* the form,
  // so there is no published version to lock).
  @Column({ type: 'int', nullable: true })
  formDefinitionVersion: number | null;

  // Human-facing label for an ad-hoc task (a definition-backed task takes its
  // title from the definition's code). Optional, only meaningful with an inline form.
  @Column({ type: 'varchar', nullable: true })
  name: string | null;

  // Inline (ad-hoc) form. When set, the task is validated against this schema at
  // completion instead of a published form version — opt-in and ungoverned
  // (no version locking, field visibility, outcomes, or draft/publish).
  @Column({ type: 'jsonb', nullable: true })
  inlineFormSchema: Record<string, unknown> | null;

  @Column({ type: 'jsonb', nullable: true })
  inlineUiSchema: Record<string, unknown> | null;

  @Column({ type: 'varchar' })
  workflowId: string;

  @Column({ type: 'varchar', nullable: true })
  processInstanceId: string | null;

  @Column({
    type: 'enum',
    enum: TaskStatus,
    default: TaskStatus.CREATED,
  })
  status: TaskStatus;

  @ManyToOne(() => User, { nullable: true })
  @JoinColumn({ name: 'assignee_id' })
  assignee: User | null;

  @Column({ type: 'uuid', name: 'assignee_id', nullable: true })
  assigneeId: string | null;

  // Per-instance candidates, snapshotted from the task definition at creation
  // (or overridden on POST /tasks). These — plus the assignee — are the
  // need-to-know read boundary: a non-oversight user may only see a task they
  // are the assignee of, a candidate user of (by email), or a candidate group
  // member of (by group name).
  @Column('text', { array: true, default: '{}' })
  candidateGroups: string[];

  @Column('text', { array: true, default: '{}' })
  candidateUsers: string[];

  @Column({ type: 'jsonb', default: () => "'{}'" })
  inputData: Record<string, unknown>;

  @Column({ type: 'jsonb', default: () => "'{}'" })
  contextData: Record<string, unknown>;

  @Column({ type: 'jsonb', default: () => "'{}'" })
  submissionData: Record<string, unknown>;

  @Column({
    type: 'enum',
    enum: Priority,
    default: Priority.NORMAL,
  })
  priority: Priority;

  @Column({ type: 'timestamptz', nullable: true })
  dueDate: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  followUpDate: Date | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  completedAt: Date | null;

  @Column({ type: 'enum', enum: SignalStatus, nullable: true })
  signalStatus: SignalStatus | null;

  @Column({ type: 'timestamptz', nullable: true })
  signalDeliveredAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  signalFailedAt: Date | null;
}
