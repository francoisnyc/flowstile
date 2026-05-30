import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

@Entity('cases')
@Index('idx_case_process_definition_id', ['processDefinitionId'])
export class Case {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', unique: true })
  processInstanceId: string;

  @Column({ type: 'uuid', nullable: true })
  processDefinitionId: string | null;

  @Column({ type: 'varchar', nullable: true })
  title: string | null;

  // The authoritative cross-task business data for this case. Read-back-able by
  // the workflow and validated against the process definition's caseEntitySchema
  // (when one is configured). Written via JSON Patch or full replace.
  @Column({ type: 'jsonb', nullable: true })
  entity: Record<string, unknown> | null;

  // Monotonic counter bumped on every entity write, for optimistic concurrency
  // (If-Match) on same-field read-modify-write from concurrent workflow branches.
  @Column({ type: 'int', default: 0 })
  entityVersion: number;

  @Column({ type: 'uuid', nullable: true })
  startedById: string | null;

  @CreateDateColumn()
  createdAt: Date;
}
