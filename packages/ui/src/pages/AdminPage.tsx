import React, { useState, useEffect, useCallback } from 'react';
import {
  listUsers, createUser, updateUser,
  listGroups, createGroup, updateGroup,
  listRoles,
} from '../api/client.js';
import type { User, Group, RoleRef } from '../types.js';

type Tab = 'users' | 'groups';

export default function AdminPage() {
  const [tab, setTab] = useState<Tab>('users');
  const [users, setUsers] = useState<User[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [roles, setRoles] = useState<RoleRef[]>([]);

  const reload = useCallback(async () => {
    try {
      const [u, g, r] = await Promise.all([listUsers(), listGroups(), listRoles()]);
      setUsers(u);
      setGroups(g);
      setRoles(r);
    } catch (err) {
      console.error(err);
    }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  return (
    <div className="admin-page">
      <div className="admin-tab-bar">
        <button
          className={`tab ${tab === 'users' ? 'active' : ''}`}
          onClick={() => setTab('users')}
        >
          Users ({users.length})
        </button>
        <button
          className={`tab ${tab === 'groups' ? 'active' : ''}`}
          onClick={() => setTab('groups')}
        >
          Groups ({groups.length})
        </button>
      </div>
      {tab === 'users' ? (
        <UsersPanel users={users} groups={groups} roles={roles} onReload={reload} />
      ) : (
        <GroupsPanel groups={groups} users={users} onReload={reload} />
      )}
    </div>
  );
}

// ── Users ────────────────────────────────────────────────────────────────────

type UserPanel = { mode: 'create' } | { mode: 'edit'; user: User };

function UsersPanel({ users, groups, roles, onReload }: {
  users: User[];
  groups: Group[];
  roles: RoleRef[];
  onReload: () => Promise<void>;
}) {
  const [panel, setPanel] = useState<UserPanel | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Create fields
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  // Shared edit fields
  const [displayName, setDisplayName] = useState('');
  const [status, setStatus] = useState('active');
  const [roleIds, setRoleIds] = useState<string[]>([]);
  const [groupIds, setGroupIds] = useState<string[]>([]);

  const openCreate = () => {
    setPanel({ mode: 'create' });
    setEmail(''); setPassword(''); setDisplayName('');
    setStatus('active'); setRoleIds([]); setGroupIds([]);
    setError(null);
  };

  const openEdit = (user: User) => {
    setPanel({ mode: 'edit', user });
    setDisplayName(user.displayName);
    setStatus(user.status);
    setRoleIds(user.roles.map((r) => r.id));
    setGroupIds(user.groups.map((g) => g.id));
    setError(null);
  };

  const toggleId = (ids: string[], id: string, set: (v: string[]) => void) =>
    set(ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (panel?.mode === 'create') {
        await createUser({ email, displayName, password, roleIds, groupIds });
        await onReload();
        setPanel(null);
      } else if (panel?.mode === 'edit') {
        const updated = await updateUser(panel.user.id, { displayName, status, roleIds, groupIds });
        await onReload();
        openEdit(updated);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="admin-content">
      <div className="admin-list">
        <div className="admin-list-header">
          <button className="primary" onClick={openCreate}>New user</button>
        </div>
        <div className="admin-list-items">
          {users.map((u) => (
            <div
              key={u.id}
              className={`admin-item ${panel?.mode === 'edit' && panel.user.id === u.id ? 'selected' : ''}`}
              onClick={() => openEdit(u)}
            >
              <span className="admin-item-name">{u.displayName}</span>
              <span className="admin-item-sub">{u.email}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="admin-detail">
        {panel ? (
          <form className="admin-form" onSubmit={handleSubmit}>
            <h3>{panel.mode === 'create' ? 'New user' : 'Edit user'}</h3>
            {error && <div className="error-banner">{error}</div>}

            {panel.mode === 'create' && (
              <>
                <label>
                  Email
                  <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
                </label>
                <label>
                  Password
                  <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
                </label>
              </>
            )}

            <label>
              Display name
              <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} required />
            </label>

            {panel.mode === 'edit' && (
              <label>
                Status
                <select value={status} onChange={(e) => setStatus(e.target.value)}>
                  <option value="active">Active</option>
                  <option value="inactive">Inactive</option>
                </select>
              </label>
            )}

            {roles.length > 0 && (
              <div className="admin-field">
                <div className="admin-field-label">Roles</div>
                <div className="checkbox-list">
                  {roles.map((r) => (
                    <label key={r.id} className="checkbox-item">
                      <input
                        type="checkbox"
                        checked={roleIds.includes(r.id)}
                        onChange={() => toggleId(roleIds, r.id, setRoleIds)}
                      />
                      <span>{r.name}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}

            {groups.length > 0 && (
              <div className="admin-field">
                <div className="admin-field-label">Groups</div>
                <div className="checkbox-list">
                  {groups.map((g) => (
                    <label key={g.id} className="checkbox-item">
                      <input
                        type="checkbox"
                        checked={groupIds.includes(g.id)}
                        onChange={() => toggleId(groupIds, g.id, setGroupIds)}
                      />
                      <span>{g.name}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}

            <div className="admin-actions">
              <button type="button" onClick={() => setPanel(null)}>Cancel</button>
              <button type="submit" className="primary" disabled={busy}>
                {panel.mode === 'create' ? 'Create' : 'Save'}
              </button>
            </div>
          </form>
        ) : (
          <p className="admin-empty">Select a user or create a new one</p>
        )}
      </div>
    </div>
  );
}

// ── Groups ───────────────────────────────────────────────────────────────────

type GroupPanel = { mode: 'create' } | { mode: 'edit'; group: Group };

function GroupsPanel({ groups, users, onReload }: {
  groups: Group[];
  users: User[];
  onReload: () => Promise<void>;
}) {
  const [panel, setPanel] = useState<GroupPanel | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [memberIds, setMemberIds] = useState<string[]>([]);

  const openCreate = () => {
    setPanel({ mode: 'create' });
    setName(''); setMemberIds([]);
    setError(null);
  };

  const openEdit = (g: Group) => {
    setPanel({ mode: 'edit', group: g });
    setName(g.name);
    setMemberIds(g.members.map((m) => m.id));
    setError(null);
  };

  const toggleMember = (id: string) =>
    setMemberIds((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (panel?.mode === 'create') {
        await createGroup({ name, memberIds });
        await onReload();
        setPanel(null);
      } else if (panel?.mode === 'edit') {
        const updated = await updateGroup(panel.group.id, { name, memberIds });
        await onReload();
        openEdit(updated);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="admin-content">
      <div className="admin-list">
        <div className="admin-list-header">
          <button className="primary" onClick={openCreate}>New group</button>
        </div>
        <div className="admin-list-items">
          {groups.map((g) => (
            <div
              key={g.id}
              className={`admin-item ${panel?.mode === 'edit' && panel.group.id === g.id ? 'selected' : ''}`}
              onClick={() => openEdit(g)}
            >
              <span className="admin-item-name">{g.name}</span>
              <span className="admin-item-sub">
                {g.members.length} member{g.members.length !== 1 ? 's' : ''}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="admin-detail">
        {panel ? (
          <form className="admin-form" onSubmit={handleSubmit}>
            <h3>{panel.mode === 'create' ? 'New group' : 'Edit group'}</h3>
            {error && <div className="error-banner">{error}</div>}

            <label>
              Name
              <input value={name} onChange={(e) => setName(e.target.value)} required />
            </label>

            {users.length > 0 && (
              <div className="admin-field">
                <div className="admin-field-label">Members</div>
                <div className="checkbox-list">
                  {users.map((u) => (
                    <label key={u.id} className="checkbox-item">
                      <input
                        type="checkbox"
                        checked={memberIds.includes(u.id)}
                        onChange={() => toggleMember(u.id)}
                      />
                      <span>
                        {u.displayName}
                        <span className="admin-item-sub"> — {u.email}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            )}

            <div className="admin-actions">
              <button type="button" onClick={() => setPanel(null)}>Cancel</button>
              <button type="submit" className="primary" disabled={busy}>
                {panel.mode === 'create' ? 'Create' : 'Save'}
              </button>
            </div>
          </form>
        ) : (
          <p className="admin-empty">Select a group or create a new one</p>
        )}
      </div>
    </div>
  );
}
