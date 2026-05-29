import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Unique,
} from 'typeorm';
import { FormDefinitionStatus, OutcomeStyle } from '../common/enums.js';

// Declarative completion buttons. Each outcome, when chosen, writes `value`
// into submissionData[outcomeKey] and completes the task via the normal
// completion endpoint — no new lifecycle states or signal-contract changes.
export interface FormOutcome {
  value: string;
  label: string;
  style?: OutcomeStyle;
  requireFields?: string[];
}

// Default submissionData key the chosen outcome value is written to when a
// form declares outcomes but does not set an explicit outcomeKey.
export const DEFAULT_OUTCOME_KEY = 'DECISION';

@Entity('form_definitions')
@Unique('uq_form_code_version', ['code', 'version'])
export class FormDefinition {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  code: string;

  @Column({ type: 'int' })
  version: number;

  @Column({ type: 'jsonb' })
  jsonSchema: Record<string, unknown>;

  @Column({ type: 'jsonb', default: () => "'{}'" })
  uiSchema: Record<string, unknown>;

  @Column({ type: 'jsonb', default: () => "'{}'" })
  visibilityRules: Record<string, unknown>;

  @Column({ type: 'jsonb', default: () => "'{}'" })
  formMessages: Record<string, unknown>;

  // Optional declarative completion buttons. Null/empty → single Complete button.
  @Column({ type: 'jsonb', nullable: true })
  outcomes: FormOutcome[] | null;

  // submissionData key the chosen outcome writes to. Null defaults to DECISION.
  @Column({ type: 'varchar', nullable: true })
  outcomeKey: string | null;

  @Column({
    type: 'enum',
    enum: FormDefinitionStatus,
    default: FormDefinitionStatus.DRAFT,
  })
  status: FormDefinitionStatus;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
