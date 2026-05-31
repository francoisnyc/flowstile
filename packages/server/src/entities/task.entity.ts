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

  @ManyToOne(() => TaskDefinition)
  @JoinColumn({ name: 'task_definition_id' })
  taskDefinition: TaskDefinition;

  @Column({ type: 'uuid', name: 'task_definition_id' })
  taskDefinitionId: string;

  @Column({ type: 'int' })
  formDefinitionVersion: number;

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
