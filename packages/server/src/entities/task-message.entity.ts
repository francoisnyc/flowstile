import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';
import { TaskMessageRole } from '../common/enums.js';

// A single message in a chat task's conversation. The raw transcript, stored so
// the inbox can render it and it stays auditable. Distinct from the case-event
// log (which is the curated business timeline) — this is the verbatim exchange.
@Entity('task_messages')
@Index('idx_task_message_task_id', ['taskId'])
export class TaskMessage {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  taskId: string;

  @Column({ type: 'enum', enum: TaskMessageRole })
  role: TaskMessageRole;

  @Column({ type: 'text' })
  content: string;

  @CreateDateColumn()
  createdAt: Date;
}
