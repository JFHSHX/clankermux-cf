// 前端 API 客户端
const BASE = '/api';

async function req<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(BASE + path, {
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
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
  preview: (o: Record<string, any>) => req('/preview', { method: 'POST', body: JSON.stringify(o) }),
  resetAll: () => req('/reset-all', { method: 'POST' }),
  health: () => req('/health'),
};