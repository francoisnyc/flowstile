import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  OneToMany,
} from 'typeorm';
import { ProcessDefinitionStatus } from '../common/enums.js';
import { TaskDefinition } from './task-definition.entity.js';

@Entity('process_definitions')
export class ProcessDefinition {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  name: string;

  @Column({ type: 'int', default: 1 })
  version: number;

  @Column({
    type: 'enum',
    enum: ProcessDefinitionStatus,
    default: ProcessDefinitionStatus.ACTIVE,
  })
  status: ProcessDefinitionStatus;

  // Optional JSON Schema for the case entity (the authoritative cross-task
  // business data). When present, every case entity write is validated against
  // it. When absent, the case entity is unvalidated (free-form display facts).
  @Column({ type: 'jsonb', nullable: true })
  caseEntitySchema: Record<string, unknown> | null;

  // Portal start: the code of the published form users fill to initiate this
  // process from the Tasklist UI. Null = process cannot be portal-started.
  @Column({ type: 'varchar', nullable: true })
  startFormCode: string | null;

  // The Temporal workflow function name to invoke on portal start.
  @Column({ type: 'varchar', nullable: true })
  workflowType: string | null;

  // The Temporal task queue on which the worker is registered.
  @Column({ type: 'varchar', nullable: true })
  taskQueue: string | null;

  @OneToMany(() => TaskDefinition, (td) => td.processDefinition)
  taskDefinitions: TaskDefinition[];

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
