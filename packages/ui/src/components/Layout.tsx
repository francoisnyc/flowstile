import React from 'react';
import { Outlet, NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.js';
import { logout } from '../api/client.js';

export default function Layout() {
  const { user, setUser } = useAuth();
  const navigate = useNavigate();
  const canAdmin = user?.roles.some((r) => r.permissions.includes('users:manage')) ?? false;

  const handleLogout = async () => {
    await logout().catch(() => {});
    setUser(null);
    navigate('/login');
  };

  return (
    <div className="app-shell">
      <header className="topnav">
        <span className="brand">Flowstile</span>
        <nav className="topnav-links">
          <NavLink to="/inbox">Inbox</NavLink>
          <NavLink to="/forms">Forms</NavLink>
          {canAdmin && <NavLink to="/admin">Admin</NavLink>}
        </nav>
        <div className="topnav-user">
          <span>{user?.displayName}</span>
          <button onClick={handleLogout}>Logout</button>
        </div>
      </header>
      <div className="page-content">
        <Outlet />
      </div>
    </div>
  );
}
