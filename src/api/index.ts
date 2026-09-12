// 管理 API — 账户池 CRUD + 策略设置 + 用量 + 审计
import { Hono } from 'hono';
import type { Env } from '../env.d';
import { Db } from '../lib/db';
import { buildBalancer } from '../strategies';
import { Eligibility } from '../strategies/eligibility';
import { snapshotAll, doResetAll } from '../lib/durable-client';
import type { Account } from '../types';
import { crypto } from './_crypto';

type Bindings = { Bindings: Env };

export const api = new Hono<Bindings>();

// 简单认证: 若配置了 DASHBOARD_PASSWORD, 管理接口需要 x-admin-token
api.use('*', async (c, next) => {
  const secret = c.env.DASHBOARD_PASSWORD;
  if (secret) {
    const provided = c.req.header('x-admin-token') || c.req.query('token');
    if (provided !== secret) return c.json({ error: 'unauthorized' }, 401);
  }
  await next();
});

// ---------- 设置 / 轮换策略 ----------
const STRATEGY_DEFAULTS: Record<string, unknown> = {
  strategy: 'fefo',
  session_duration_hours: 5,
  fefo_budget_5h: 500_000,
  fefo_budget_weekly: 3_500_000,
  cooldown_429_seconds: 60,
  cooldown_529_seconds: 30,
  probe_backoff_seconds: 60,
  max_failover: 4,
  burst_retry_enabled: 'true',
  openai_upstream: 'https://api.openai.com/v1',
  anthropic_upstream: 'https://api.anthropic.com',
};

api.get('/settings', async (c) => {
  const db = new Db(c.env.DB);
  const stored = await db.getAllSettings();
  const merged = { ...STRATEGY_DEFAULTS, ...stored };
  return c.json(merged);
});

api.put('/settings', async (c) => {
  const db = new Db(c.env.DB);
  const body = await c.req.json().catch(() => ({}));
  const keys = Object.keys(STRATEGY_DEFAULTS);
  for (const k of keys) {
    if (body[k] !== undefined) await db.setSetting(k, String(body[k]));
  }
  return c.json({ ok: true });
});

// ---------- 账户 ----------
api.get('/accounts', async (c) => {
  const db = new Db(c.env.DB);
  const accounts = await db.listAccounts(true);
  // 附加利用率
  const el = new Eligibility(db);
  await el.warmUsage(accounts.filter((a) => !a.disabled));
  // 脱敏: 不返回 api_key / enc_key 明文
  const safe = accounts.map((a) => ({ ...a, api_key: a.api_key ? '••••••••' : null, enc_key: a.enc_key ? '••••••••' : null, utilization: Math.round(el.utilization(a, Date.now())) }));
  // 附加熔断快照
  let circuits: Record<string, any> = {};
  try { circuits = (await snapshotAll(c.env)).circuits ?? {}; } catch { /* DO 可能未就绪 */ }
  const enriched = safe.map((a) => ({ ...a, circuit: circuits[a.id] ?? null }));
  return c.json(enriched);
});

// 创建账户
api.post('/accounts', async (c) => {
  const db = new Db(c.env.DB);
  const body = await c.req.json().catch(() => ({}));
  if (!body.name) return c.json({ error: 'name required' }, 400);
  const id = crypto.randomUUID();
  await db.createAccount({
    id,
    name: body.name,
    provider: body.provider ?? 'custom',
    base_url: body.base_url || null,
    api_key: body.api_key || null,
    priority: body.priority ?? 0,
    weight: body.weight ?? 1,
    auto_fallback: body.auto_fallback === false ? 0 : 1,
    max_concurrent: body.max_concurrent ?? 0,
    model_mappings: body.model_mappings ? JSON.stringify(body.model_mappings) : null,
    custom_headers: body.custom_headers ? JSON.stringify(body.custom_headers) : null,
    notes: body.notes || null,
  });
  return c.json({ ok: true, id });
});

api.put('/accounts/:id', async (c) => {
  const db = new Db(c.env.DB);
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const patch: Partial<Account> = {};
  if (body.name !== undefined) patch.name = body.name;
  if (body.provider !== undefined) patch.provider = body.provider;
  if (body.base_url !== undefined) patch.base_url = body.base_url;
  if (body.api_key !== undefined) patch.api_key = body.api_key;
  if (body.priority !== undefined) patch.priority = body.priority;
  if (body.weight !== undefined) patch.weight = body.weight;
  if (body.auto_fallback !== undefined) patch.auto_fallback = body.auto_fallback ? 1 : 0;
  if (body.max_concurrent !== undefined) patch.max_concurrent = body.max_concurrent;
  if (body.model_mappings !== undefined) patch.model_mappings = body.model_mappings ? JSON.stringify(body.model_mappings) : null;
  if (body.custom_headers !== undefined) patch.custom_headers = body.custom_headers ? JSON.stringify(body.custom_headers) : null;
  if (body.notes !== undefined) patch.notes = body.notes;
  if (body.disabled !== undefined) patch.disabled = body.disabled ? 1 : 0;
  // paused / resume
  if (body.pause === true) patch.paused = 1;
  if (body.pause === false) {
    await db.resumeAccount(id);
    patch.paused = 0;
  }
  await db.updateAccount(id, patch);
  return c.json({ ok: true });
});

api.delete('/accounts/:id', async (c) => {
  const db = new Db(c.env.DB);
  await db.deleteAccount(c.req.param('id'));
  return c.json({ ok: true });
});

api.post('/accounts/:id/pause', async (c) => {
  const db = new Db(c.env.DB);
  await db.pauseAccount(c.req.param('id'), 'manual');
  return c.json({ ok: true });
});

api.post('/accounts/:id/resume', async (c) => {
  const db = new Db(c.env.DB);
  await db.resumeAccount(c.req.param('id'));
  return c.json({ ok: true });
});

api.post('/accounts/:id/reset-circuit', async (c) => {
  const db = new Db(c.env.DB);
  await db.resumeAccount(c.req.param('id'));
  return c.json({ ok: true });
});

// ---------- 用量 / 统计 ----------
api.get('/stats', async (c) => {
  const db = new Db(c.env.DB);
  const hours = parseInt(c.req.query('hours') || '1', 10);
  const from = Date.now() - hours * 3600 * 1000;
  const pool = await db.poolStats(from);
  // 附账户利用率
  const accounts = await db.listAccounts(false);
  const el = new Eligibility(db);
  await el.warmUsage(accounts);
  const utilization = accounts.map((a) => ({ id: a.id, name: a.name, utilization: Math.round(el.utilization(a, Date.now())), capacity: el.capacity ? el.capacity(a, Date.now()) : null }));
  return c.json({ ...pool, utilization });
});

api.get('/requests', async (c) => {
  const db = new Db(c.env.DB);
  const limit = Math.min(parseInt(c.req.query('limit') || '50', 10), 200);
  return c.json({ requests: await db.recentRequests(limit) });
});

api.delete('/requests', async (c) => {
  const db = new Db(c.env.DB);
  await db.clearRequests();
  return c.json({ ok: true });
});

// ---------- 熔断状态 ----------
api.get('/circuits', async (c) => {
  const snap = await snapshotAll(c.env);
  return c.json(snap);
});

api.post('/reset-all', async (c) => {
  const db = new Db(c.env.DB);
  await doResetAll(c.env);
  // 恢复所有熔断暂停的账户
  const accounts = await db.listAccounts(true);
  for (const a of accounts) {
    if (a.pause_reason === 'rate_limit') await db.resumeAccount(a.id);
  }
  return c.json({ ok: true });
});

// ---------- 轮换预览 ----------
api.post('/preview', async (c) => {
  const db = new Db(c.env.DB);
  const body = await c.req.json().catch(() => ({}));
  const strategy = body.strategy ?? 'fefo';
  const durationHours = body.session_duration_hours ?? 5;
  const budget5h = body.fefo_budget_5h ? Number(body.fefo_budget_5h) : 500_000;
  const budgetWeekly = body.fefo_budget_weekly ? Number(body.fefo_budget_weekly) : 3_500_000;

  const accounts = await db.listAccounts(false);
  const el = new Eligibility(db, { budget5h, budgetWeekly });
  await el.warmUsage(accounts);
  const balancer = buildBalancer(strategy, durationHours);
  const meta = {
    path: '/wire/openai/v1/chat/completions',
    method: 'POST',
    requestedModel: body.model ?? null,
    affinityKey: body.affinityKey ?? null,
    header: new Headers(),
    body: '{}',
    strategy,
  } as any;
  const ranked = balancer.rank(accounts, meta, el);
  const ordered = ranked.map((a) => ({ id: a.id, name: a.name, priority: a.priority, utilization: Math.round(el.utilization(a, Date.now())) }));
  return c.json({ strategy, selected: ordered[0] ?? null, ranked: ordered });
});

// 健康检查
api.get('/health', (c) => c.json({ ok: true, ts: Date.now() }));