import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';
import { OutboxStatus } from '../common/enums.js';

// A durable record of a Temporal signal that must be delivered to a workflow.
// Written in the same transaction as the task state change that produced it,
// then drained by the signal-relay background loop with backoff and retries.
@Entity('signal_outbox')
@Index('idx_outbox_status_next', ['status', 'nextAttemptAt'])
@Index('idx_outbox_task', ['taskId'])
export class SignalOutbox {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  taskId: string;

  @Column({ type: 'varchar' })
  workflowId: string;

  @Column({ type: 'varchar' })
  signalName: string;

  // null for cancellation signals (which carry no payload)
  @Column({ type: 'jsonb', nullable: true })
  payload: unknown | null;

  @Column({ type: 'enum', enum: OutboxStatus, default: OutboxStatus.PENDING })
  status: OutboxStatus;

  @Column({ type: 'int', default: 0 })
  attempts: number;

  @Column({ type: 'int', default: 10 })
  maxAttempts: number;

  @Column({ type: 'timestamptz' })
  nextAttemptAt: Date;

  @Column({ type: 'text', nullable: true })
  lastError: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  deliveredAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
