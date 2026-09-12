import { useCallback, useEffect, useState } from 'react';
import { api, getAdminToken, setAdminToken, isUnauthorized, UNAUTHORIZED_EVENT } from './lib/api';

/**
 * 管理面板登录门禁:
 *  - 挂载时探测 /api/settings: 200 -> 直接进面板; 401 -> 显示密码框
 *  - 密码即 x-admin-token, 存 localStorage
 *  - 面板内任何请求收到 401 时 (api.ts 广播事件) 自动退回登录页
 */
export default function AuthGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<'checking' | 'login' | 'ok'>('checking');
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const probe = useCallback(async () => {
    try {
      await api.settings();
      setState('ok');
    } catch (e) {
      if (isUnauthorized(e)) { setState('login'); setAdminToken(''); }
      else setState('ok'); // 网络/5xx 等非鉴权错误, 放行让面板自己报错
    }
  }, []);

  useEffect(() => { void probe(); }, [probe]);
  useEffect(() => {
    const on401 = () => setState('login');
    window.addEventListener(UNAUTHORIZED_EVENT, on401);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, on401);
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr('');
    setAdminToken(pw.trim());
    try {
      await api.settings();
      setState('ok');
    } catch (e2) {
      setAdminToken('');
      setErr(isUnauthorized(e2) ? '密码错误' : `连接失败: ${(e2 as Error).message}`);
      setState('login');
    } finally { setBusy(false); }
  };

  if (state === 'checking') {
    return <Center><div className="muted">检查访问权限…</div></Center>;
  }
  if (state === 'ok') return <>{children}</>;

  return (
    <Center>
      <form onSubmit={submit} className="card" style={{ width: 320, textAlign: 'center' }}>
        <h2 style={{ marginBottom: '.5rem' }}>⚡ ClankerMux</h2>
        <p className="muted" style={{ marginTop: 0 }}>管理面板已锁定，请输入访问密码</p>
        <input
          type="password" autoFocus value={pw} placeholder="DASHBOARD_PASSWORD"
          style={{ width: '100%', marginTop: '.5rem' }}
          onChange={(e) => setPw(e.target.value)}
        />
        {err && <div style={{ color: 'var(--red)', fontSize: '.82rem', marginTop: '.5rem' }}>{err}</div>}
        <button className="btn primary" style={{ width: '100%', marginTop: '.8rem' }} disabled={busy || !pw.trim()}>
          {busy ? '验证中…' : '进入面板'}
        </button>
      </form>
    </Center>
  );
}

function Center({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: '1rem' }}>
      {children}
    </div>
  );
}
