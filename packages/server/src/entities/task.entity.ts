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
import { TaskStatus, Priority } from '../common/enums.js';
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
  processInstanceId: string;

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
}
