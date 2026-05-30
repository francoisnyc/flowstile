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

  @Column({ type: 'jsonb', nullable: true })
  variables: Record<string, unknown> | null;

  @Column({ type: 'uuid', nullable: true })
  startedById: string | null;

  @CreateDateColumn()
  createdAt: Date;
}
