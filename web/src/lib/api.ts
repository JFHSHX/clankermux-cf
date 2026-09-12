// 前端 API 客户端 — 自动附带管理令牌 (x-admin-token)
const BASE = '/api';
const TOKEN_KEY = '***';

// 任何请求收到 401 时广播此事件, AuthGate 监听并退回登录页
export const UNAUTHORIZED_EVENT = 'clankermux-unauthorized';

export function getAdminToken(): string {
  try { return localStorage.getItem(TOKEN_KEY) ?? ''; } catch { return ''; }
}
export function setAdminToken(t: string): void {
  try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch {}
}
export function isUnauthorized(e: unknown): boolean {
  return String((e as Error)?.message ?? '').startsWith('401');
}

async function req<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getAdminToken();
  const res = await fetch(BASE + path, {
    headers: {
      'content-type': 'application/json',
      ...(token ? { 'x-admin-token': token } : {}),
      ...(options.headers || {}),
    },
    ...options,
  });
  if (res.status === 401) {
    window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    throw new Error('401: unauthorized');
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  settings: () => req<Record<string, string>>('/settings'),
  saveSettings: (s: Record<string, any>) => req('/settings', { method: 'PUT', body: JSON.stringify(s) }),
  accounts: () => req<any[]>('/accounts'),
  createAccount: (a: Record<string, any>) => req('/accounts', { method: 'POST', body: JSON.stringify(a) }),
  updateAccount: (id: string, a: Record<string, any>) => req(`/accounts/${id}`, { method: 'PUT', body: JSON.stringify(a) }),
  deleteAccount: (id: string) => req(`/accounts/${id}`, { method: 'DELETE' }),
  pauseAccount: (id: string) => req(`/accounts/${id}/pause`, { method: 'POST' }),
  resumeAccount: (id: string) => req(`/accounts/${id}/resume`, { method: 'POST' }),
  resetCircuit: (id: string) => req(`/accounts/${id}/reset-circuit`, { method: 'POST' }),
  stats: (hours = 1) => req<any>(`/stats?hours=${hours}`),
  requests: (limit = 50) => req<any>(`/requests?limit=${limit}`),
  circuits: () => req<any>('/circuits'),
  models: (refresh = false) => req<any>(`/models${refresh ? '?refresh=1' : ''}`),
  preview: (o: Record<string, any>) => req('/preview', { method: 'POST', body: JSON.stringify(o) }),
  resetAll: () => req('/reset-all', { method: 'POST' }),
  health: () => req('/health'),
};
