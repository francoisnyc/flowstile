import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';
import { AttachmentStatus, type PayloadScope } from '../common/enums.js';

@Entity('attachments')
@Index('idx_attachment_task_id', ['taskId'])
@Index('idx_attachment_process_instance_id', ['processInstanceId'])
@Index('idx_attachment_status_created_at', ['status', 'createdAt'])
export class Attachment {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', nullable: true })
  taskId: string | null;

  // Denormalized from the task at link time. Enables whole-case document listing
  // as WHERE processInstanceId = ? without a join (Flowable ContentItem pattern).
  @Column({ type: 'varchar', nullable: true })
  processInstanceId: string | null;

  // The form field property key this attachment is associated with.
  @Column({ type: 'varchar', nullable: true })
  fieldKey: string | null;

  // Which task payload the reference lives in.
  @Column({ type: 'varchar', nullable: true })
  payloadScope: PayloadScope | null;

  @Column({ type: 'varchar' })
  storageKey: string;

  @Column({ type: 'varchar' })
  storeId: string; // 'local' | 's3'

  @Column({ type: 'varchar' })
  fileName: string;

  @Column({ type: 'varchar' })
  contentType: string;

  @Column({ type: 'bigint' })
  size: number;

  @Column({ type: 'varchar' })
  checksum: string; // hex sha256

  @Column({ type: 'uuid', nullable: true })
  uploadedById: string | null;

  @Column({
    type: 'enum',
    enum: AttachmentStatus,
    default: AttachmentStatus.PENDING,
  })
  status: AttachmentStatus;

  @CreateDateColumn()
  createdAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  linkedAt: Date | null;
}
