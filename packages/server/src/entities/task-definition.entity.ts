import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { Priority } from '../common/enums.js';
import { ProcessDefinition } from './process-definition.entity.js';

@Entity('task_definitions')
export class TaskDefinition {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', unique: true })
  code: string;

  @ManyToOne(() => ProcessDefinition, (pd) => pd.taskDefinitions, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'process_definition_id' })
  processDefinition: ProcessDefinition;

  @Column({ type: 'uuid', name: 'process_definition_id' })
  processDefinitionId: string;

  @Column({ type: 'varchar' })
  formDefinitionCode: string;

  @Column('text', { array: true, default: '{}' })
  candidateGroups: string[];

  @Column('text', { array: true, default: '{}' })
  candidateUsers: string[];

  @Column({
    type: 'enum',
    enum: Priority,
    default: Priority.NORMAL,
  })
  defaultPriority: Priority;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
