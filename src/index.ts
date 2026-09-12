// ClankerMux Worker — 单入口
// 路由:
//   /wire/openai/*        OpenAI 兼容代理 (chat completions, responses, models)
//   /wire/anthropic/*     Anthropic 代理
//   /api/*                管理 API (账户池 / 策略 / 用量)
//   /                     前端仪表盘 (静态资源, 由 build 产物提供)
import { Hono } from 'hono';
import type { Env } from './env.d';
import { Db } from './lib/db';
import { buildBalancer } from './strategies';
import { Eligibility } from './strategies/eligibility';
import { proxyRequest } from './proxy/proxy';
import { api } from './api';
import type { RequestMeta, LoadBalancingStrategy } from './types';

type Bindings = { Bindings: Env };

const app = new Hono<Bindings>();

// ---------- 挂载管理 API ----------
app.route('/api', api);

// 诊断: 测试 worker 到任意 URL 的出站 fetch 连通性 (仅本地调试)
app.get('/api/__debug_fetch', async (c) => {
  try {
    const target = c.req.query('url') || 'http://localhost:9100/health';
    const method = c.req.query('method') || 'GET';
    const r = await fetch(target, {
      method,
      headers: { 'content-type': 'application/json' },
      body: method === 'POST' ? JSON.stringify({ model: 'x', messages: [{ role: 'user', content: 'hi' }] }) : undefined,
      signal: AbortSignal.timeout(8000),
    });
    const txt = await r.text();
    return c.json({ ok: true, status: r.status, target, method, body: txt.slice(0, 300) });
  } catch (err: any) {
    return c.json({ ok: false, error: String(err?.message || err) }, 502);
  }
});

// ---------- 代理入口 ----------
app.all('/wire/openai/*', handleWire('openai'));
app.all('/wire/anthropic/*', handleWire('anthropic'));
app.all('/wire/*', (c) => c.json({ error: 'unknown wire mount' }, 404));

// ---------- 健康 ----------
app.get('/health', (c) => c.json({ ok: true, ts: Date.now() }));

// ---------- 前端静态资源 ----------
// 若资产存在则由 ASSETS 提供; 否则返回内置提示页
app.get('*', async (c) => {
  try {
    const resp = await c.env.ASSETS.fetch(c.req.raw);
    if (resp.status !== 404) return resp;
  } catch {
    // ASSETS 未就绪
  }
  return new Response(
    '<html><body style="font-family:system-ui;display:grid;place-items:center;height:100vh">' +
      '<div style="text-align:center"><h1>ClankerMux Worker</h1>' +
      '<p>未构建前端. 请先运行 <code>npm run build:web</code> 或部署完整产物.</p>' +
      '<p>代理端点: <code>/wire/openai/v1/chat/completions</code></p>' +
      '<p>管理 API: <code>/api</code></p></div></body></html>',
    { status: 200, headers: { 'content-type': 'text/html' } },
  );
});

// 策略实例缓存: FefoStrategy 的 lastPickedAt、round-robin 游标、会话粘性
// 都是实例态, 必须跨请求复用 (同一 isolate 内), 否则突发轮换/粘性永不生效。
const balancerCache = new Map<string, ReturnType<typeof buildBalancer>>();
function getBalancer(strategy: LoadBalancingStrategy, sessionHours: number) {
  const key = `${strategy}:${sessionHours}`;
  let b = balancerCache.get(key);
  if (!b) { b = buildBalancer(strategy, sessionHours); balancerCache.set(key, b); }
  return b;
}

// 代理处理器工厂
function handleWire(provider: 'openai' | 'anthropic') {
  return async (c: any) => {
    const env: Env = c.env;
    const req: Request = c.req.raw;
    const db = new Db(env.DB);

    // 读取轮换策略设置
    const settings = await db.getAllSettings();
    const strategy = (settings.strategy ?? env.STRATEGY ?? 'fefo') as LoadBalancingStrategy;
    const sessionHours = Number(settings.session_duration_hours ?? 5);
    const budget5h = Number(settings.fefo_budget_5h ?? 500_000);
    const budgetWeekly = Number(settings.fefo_budget_weekly ?? 3_500_000);

    const balancer = buildBalancer(strategy, sessionHours);
    const eligibility = new Eligibility(db, { budget5h, budgetWeekly });

    // 组装请求元数据
    const body = req.method === 'GET' || req.method === 'HEAD' ? '' : await req.text();
    let requestedModel: string | null = null;
    try {
      const parsed = JSON.parse(body);
      requestedModel = parsed?.model || parsed?.model_id || parsed?.modelID || null;
    } catch { /* 非 JSON 或空 */ }

    // affinity key: 来源 proxy key / 项目
    const sourceApiKey = req.headers.get('x-clankermux-key') ?? null;

    const meta: RequestMeta = {
      path: new URL(req.url).pathname,
      method: req.method,
      requestedModel,
      sourceApiKey,
      header: req.headers,
      body,
      strategy,
      affinityKey: sourceApiKey,
    };

    const result = await proxyRequest(env, db, meta, balancer, eligibility);
    return result.response;
  };
}

export default app;

// DO 导出 (wrangler 需要)
export { PoolState } from './state-durable-object';