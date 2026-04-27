import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Unique,
} from 'typeorm';
import { FormDefinitionStatus } from '../common/enums.js';

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
