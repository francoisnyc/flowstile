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

  @OneToMany(() => TaskDefinition, (td) => td.processDefinition)
  taskDefinitions: TaskDefinition[];

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
