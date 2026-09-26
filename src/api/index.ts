// 管理 API — 账户池 CRUD + 策略设置 + 用量 + 审计
import { Hono } from 'hono';
import type { Env } from '../env.d';
import { Db } from '../lib/db';
import { buildBalancer } from '../strategies';
import { Eligibility } from '../strategies/eligibility';
import { snapshotAll, doResetAll } from '../lib/durable-client';
import { modelsUrlFor, modelsAuthFor } from '../proxy/proxy';
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
  timeout_first_byte_seconds: 60,
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

// ---------- 可用模型 ----------
// 聚合各账户上游 /models, 标注每个模型被哪些 key 支持。
// 结果缓存在 settings (TTL 10 分钟), ?refresh=1 或 POST /models/refresh 强制刷新。
const MODELS_CACHE_KEY = '***';
const MODELS_CACHE_TTL_MS = 10 * 60 * 1000;
// 缓存结构版本号 — 变更字段结构时+1, 使旧格式缓存失效, 避免拿到缺 Context Length 的旧数据
const MODELS_CACHE_VERSION = 2;

// 上游未返回 context_length 时的内置兜底表 (常见模型), 依 key 子串匹配
// 顺序即优先级：越具体的规则放越前面
const KNOWN_CONTEXTS: [RegExp, number][] = [
  // ========== NVIDIA Nemotron 系列 (NIM API) ==========
  [/nemotron-3-ultra/i, 1000000], [/nemotron-3-super/i, 1000000], [/nemotron-3-ultra-550b/i, 1000000],
  [/nemotron-4-340b/i, 1000000], [/nemotron-4/i, 1000000],
  [/nemotron-3-nano/i, 131072], [/nemotron-3/i, 131072], [/nemotron/i, 131072],
  [/nemotron-ultra-253b/i, 1000000], [/nemotron-51b/i, 131072], [/nemotron-70b/i, 131072],

  // ========== DeepSeek ==========
  [/deepseek-v4/i, 200000], [/deepseek-v3/i, 200000], [/deepseek-coder/i, 16384], [/deepseek/i, 128000],

  // ========== OpenAI / GPT ==========
  [/gpt-4o/i, 128000], [/gpt-4-turbo/i, 128000], [/gpt-4/i, 8192], [/gpt-3\.5/i, 16385],
  [/o1/i, 200000], [/o3/i, 200000],
  [/gpt-oss/i, 131072],

  // ========== Anthropic Claude ==========
  [/claude-3-5/i, 200000], [/claude-3-7/i, 200000], [/claude-3-opus/i, 200000], [/claude/i, 100000],

  // ========== Google ==========
  [/gemini/i, 1000000],
  [/gemma-4/i, 131072], [/gemma-3/i, 131072], [/gemma-2/i, 8192], [/gemma/i, 8192],   // Gemma 4/3: 128k, Gemma 2/1: 8k
  [/codegemma/i, 8192], [/recurrentgemma/i, 8192], [/diffusiongemma/i, 8192],

  // ========== Meta / Llama 衍生 (须在 Google llama 通用规则之前，避免 codellama 被拦截) ==========
  [/codellama/i, 16384], [/llama-guard/i, 8192], [/muse-glimmer/i, 8192],

  // ========== Google Llama 系列 ==========
  [/llama-3\.2/i, 131072], [/llama-3\.1/i, 131072], [/llama3-/i, 131072], [/llama-3/i, 8192], [/llama-2/i, 4096], [/llama/i, 4096],

  // ========== Microsoft Phi ==========
  [/phi-3.*vision/i, 131072], [/phi-3\.5/i, 131072], [/phi-3/i, 4096], [/phi-4/i, 131072], [/phi/i, 4096],

  // ========== Mistral 系列 ==========
  [/mistral-large-2/i, 131072], [/mistral-large/i, 128000],
  [/codestral/i, 32768], [/mistral-nemo/i, 131072], [/mistral-7b/i, 32768], [/mistral/i, 32768],
  [/mixtral-8x22b/i, 65536], [/mixtral-8x7b/i, 32768], [/mixtral/i, 32768],

  // ========== Moonshot Kimi ==========
  [/kimi-k3/i, 200000], [/kimi-k2/i, 200000], [/kimi/i, 200000],

  // ========== 01.ai Yi ==========
  [/yi-large/i, 200000], [/yi-1\.5/i, 200000], [/yi/i, 200000],

  // ========== AI21 Jamba ==========
  [/jamba-1\.5/i, 262144], [/jamba/i, 262144],

  // ========== Writer Palmyra ==========
  [/palmyra.*32k/i, 32768], [/palmyra.*122b/i, 131072], [/palmyra/i, 32768],

  // ========== IBM Granite ==========
  [/granite-34b-code/i, 8192], [/granite-8b-code/i, 8192], [/granite-3\.0.*8b/i, 4096], [/granite-3\.0.*3b/i, 4096], [/granite/i, 4096],

  // ========== Databricks DBRX ==========
  [/dbrx/i, 32768],

  // ========== Qwen ==========
  [/qwen-2\.5/i, 131072], [/qwen-2/i, 32768], [/qwen/i, 131072],

  // ========== Z.ai GLM ==========
  [/glm-5/i, 131072], [/glm-4/i, 131072], [/glm/i, 128000],

  // ========== Zyphra Zamba ==========
  [/zamba2/i, 131072], [/zamba/i, 131072],

  // ========== 其它常见 ==========
  [/starcoder2/i, 16384], [/starcoder/i, 8192],
  [/sea-lion/i, 4096],
];

/** 解析单个上游 model 对象里的 context_length (OpenAI 风格 context_length / OpenRouter 风格同名字段) */
function contextOfModelEntry(m: any): number | undefined {
  if (m && typeof m === 'object') {
    const v = m?.context_length ?? m?.max_context_length ?? m?.max_context_tokens;
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return Math.round(n);
  }
  return undefined;
}

/** 对单个模型 ID 求 context length: 优先上游返回, 否则 KNOWN_CONTEXTS 兜底, 都没有则 null */
function resolveContextLength(id: string, perAccount: AccountModels[]): number | null {
  for (const pa of perAccount) {
    const v = pa.context?.[id];
    if (typeof v === 'number' && v > 0) return v;
  }
  for (const [re, l] of KNOWN_CONTEXTS) {
    if (re.test(id)) return l;
  }
  return null;
}

interface AccountModels {
  account: string; account_id: string; ok: boolean; error?: string;
  models: string[]; context: Record<string, number>; fetched_at: number;
}

async function fetchModelsForAccount(env: Env, acc: Account): Promise<AccountModels> {
  const base: AccountModels = {
    account: acc.name, account_id: acc.id, ok: false, models: [], context: {}, fetched_at: Date.now(),
  };
  if (!acc.base_url && acc.provider === 'custom') return { ...base, error: 'no base_url' };
  try {
    const url = modelsUrlFor(acc, env);
    const res = await fetch(url, {
      headers: { accept: 'application/json', ...modelsAuthFor(acc) },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return { ...base, error: `upstream_${res.status}` };
    const j: any = await res.json();
    // OpenAI 兼容: {data:[{id}]}; Anthropic: {data:[{id}]}; 兜底: 字符串数组
    const entries = Array.isArray(j?.data)
      ? (j.data as any[])
      : Array.isArray(j?.models) ? j.models : [];
    const models: string[] = [];
    const context: Record<string, number> = {};
    for (const e of entries) {
      const id = typeof e === 'string' ? e : e?.id;
      if (!id) continue;
      models.push(id);
      const cl = contextOfModelEntry(e);
      if (cl) context[id] = cl;
    }
    return { ...base, ok: true, models: [...new Set(models)].sort(), context };
  } catch (e: any) {
    return { ...base, error: e?.name === 'TimeoutError' ? 'timeout' : String(e?.message ?? e) };
  }
}

async function refreshAllModels(env: Env, db: Db): Promise<{ version: number; per_account: AccountModels[]; fetched_at: number }> {
  const accounts = await db.listAccounts(false);
  const usable = accounts.filter((a) => a.api_key || a.enc_key);
  const perAccount = await Promise.all(usable.map((a) => fetchModelsForAccount(env, a)));
  const result = { version: MODELS_CACHE_VERSION, per_account: perAccount, fetched_at: Date.now() };
  await db.setSetting(MODELS_CACHE_KEY, JSON.stringify(result));
  return result;
}

function aggregateModels(data: { version?: number; per_account: AccountModels[]; fetched_at: number }) {
  const byModel = new Map<string, string[]>();
  for (const pa of data.per_account) {
    for (const m of pa.models) {
      byModel.set(m, [...(byModel.get(m) ?? []), pa.account]);
    }
  }
  return {
    fetched_at: data.fetched_at,
    models: [...byModel.entries()]
      .sort((a, b) => (b[1].length - a[1].length) || a[0].localeCompare(b[0]))
      .map(([id, accounts]) => ({
        id,
        accounts,
        context_length: resolveContextLength(id, data.per_account),
      })),
    per_account: data.per_account.map((pa) => ({
      account: pa.account, ok: pa.ok, error: pa.error ?? null, count: pa.models.length,
    })),
  };
}

api.get('/models', async (c) => {
  const db = new Db(c.env.DB);
  const refresh = c.req.query('refresh') === '1';
  let data: { version?: number; per_account: AccountModels[]; fetched_at: number } | null = null;
  if (!refresh) {
    const raw = await db.getSetting(MODELS_CACHE_KEY);
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed?.version === MODELS_CACHE_VERSION && Date.now() - parsed.fetched_at < MODELS_CACHE_TTL_MS) data = parsed;
      } catch { /* 缓存损坏 -> 刷新 */ }
    }
  }
  if (!data) data = await refreshAllModels(c.env, db);
  return c.json(aggregateModels(data));
});

api.post('/models/refresh', async (c) => {
  const db = new Db(c.env.DB);
  const data = await refreshAllModels(c.env, db);
  return c.json(aggregateModels(data));
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