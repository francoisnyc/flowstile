import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
} from 'typeorm';

// A machine principal for server-to-server callers (Temporal workers, scripts).
// Deliberately NOT a User row: it carries its own permission set, is revocable
// and rotatable without touching human accounts, and is distinguishable from a
// human in audit. The full token is shown once at creation; only its SHA-256
// hash is stored.
@Entity('api_keys')
export class ApiKey {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  name: string;

  // SHA-256 hex of the full token. The plaintext token is never persisted.
  @Column({ type: 'varchar', unique: true })
  keyHash: string;

  // Leading characters of the token (e.g. "fsk_AbC1") for identification in lists.
  @Column({ type: 'varchar' })
  prefix: string;

  @Column('text', { array: true, default: '{}' })
  permissions: string[];

  @Column({ type: 'timestamp', nullable: true })
  lastUsedAt: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  expiresAt: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  revokedAt: Date | null;

  // The user who minted the key, if any (null for seed-provisioned keys).
  @Column({ type: 'uuid', nullable: true })
  createdById: string | null;

  @CreateDateColumn()
  createdAt: Date;
}
