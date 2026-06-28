import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';
import { CaseEventActor } from '../common/enums.js';

// A display-only, append-only entry on a case's timeline. Records business-
// meaningful moments performed by automated/system or AI-agent work that have no
// human-task lifecycle to surface them. Never load-bearing: the workflow writes
// it but never reads it back to drive logic (that stays in the case entity).
@Entity('case_events')
@Index('idx_case_event_case_id', ['caseId'])
export class CaseEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  caseId: string;

  @Column({ type: 'enum', enum: CaseEventActor })
  actor: CaseEventActor;

  // Human-readable summary of the moment, e.g. "Risk assessment".
  @Column({ type: 'varchar' })
  label: string;

  // Curated, projected payload (an allowlist — not a raw dump). null for events
  // that carry no data.
  @Column({ type: 'jsonb', nullable: true })
  payload: Record<string, unknown> | null;

  // Optional plan phase, to group the event on the milestone stepper.
  @Column({ type: 'varchar', nullable: true })
  phase: string | null;

  @CreateDateColumn()
  recordedAt: Date;
}
