// 代理引擎 — 转发请求到上游账户, 负载均衡 + 故障转移 + 429 熔断
import type { Account, RequestMeta, RouteDecision } from '../types';
import type { Env } from '../env.d';
import { Db } from '../lib/db';
import { Eligibility } from '../strategies/eligibility';
import type { LoadBalancer } from '../types';
import {
  circuitBreak,
  tryProbe,
  probeComplete,
  acquireSlot,
  releaseSlot,
} from '../lib/durable-client';

export interface ProxyResult {
  response: Response;
  decision?: RouteDecision;
  upstreamMs?: number;
}

// 上游路径映射: wire 挂载点 / 提供商
const UPSTREAM_PATHS: Record<string, { provider: string; getUrl: () => string }> = {
  '/wire/openai': {
    provider: 'custom',
    getUrl: () => '', // 动态填充
  },
  '/wire/anthropic': {
    provider: 'anthropic',
    getUrl: () => '',
  },
};

const MAX_FAILOVER = 4;
const CLIENT_ABORT_MSG = 'clankermux: client aborted stream';
// 首字节超时默认值 (秒): 上游在该时间内未返回响应头 -> 视为该 key 卡死, 熔断并换 key。
// 解析优先级: 管理面板设置 (DB settings) > 环境变量 TIMEOUT_FIRST_BYTE_SECONDS > 默认 60。
// 一旦响应头到达 (流式开始), 不再受此限制。
const DEFAULT_FIRST_BYTE_TIMEOUT_S = 60;
// 超时熔断冷却: 卡死的 key 短暂隔离, 让同请求立即换 key, 也避免下个请求继续排队等它
const FIRST_BYTE_COOLDOWN_MS = 60 * 1000;
const UPSTREAM_TIMEOUT_MSG = 'clankermux: upstream first-byte timeout';

// 超时阈值 (秒) 解析: 管理面板设置 (DB settings) > 环境变量 > 默认 60。
// settings 键 timeout_first_byte_seconds 由「轮换策略」面板读写。
function firstByteTimeoutMs(env: Env, stored: unknown): number {
  const n = Number(stored ?? env.TIMEOUT_FIRST_BYTE_SECONDS);
  return Number.isFinite(n) && n > 0 ? n * 1000 : DEFAULT_FIRST_BYTE_TIMEOUT_S * 1000;
}

/**
 * 带首字节超时的 fetch。signal 在 Promise 返回 (响应头到达) 后立即解绑,
 * 之后的流式 body 读取不受 timer 影响 — 满足"60s 没响应就换 key"且不误杀长流。
 * 超时抛出 name=TimeoutError 的异常, 由调用方识别处理。
 */
async function fetchWithFirstByteTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(UPSTREAM_TIMEOUT_MSG), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch (err: any) {
    if (ctrl.signal.aborted) {
      const e = new Error(`no response in ${Math.round(timeoutMs / 1000)}s`);
      e.name = 'TimeoutError';
      throw e;
    }
    throw err;
  } finally {
    clearTimeout(timer); // 响应头已到, 解除超时约束 (body 流继续读不会被 abort)
  }
}

// 转发的安全头白名单 — 剥离 hop-by-hop 头 + Cloudflare 内部头。
// 关键: workerd 会给入站请求加 cdn-loop/via/cf-* 头, 若原样转发到出站 fetch,
// Cloudflare 环路检测会直接丢连接 (表现为 "Network connection lost")
const HOP_BY_HOP = new Set([
  'host', 'content-length', 'connection', 'keep-alive', 'proxy-authenticate',
  'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade',
  // Expect: 100-continue — 上游不响应 100 时 workerd 会挂起并丢连接 (实测根因)
  'expect',
  'x-clankermux-key-id',
  // Cloudflare 内部 / 环路检测头 — 绝不能转发
  'cdn-loop', 'via', 'cf-ray', 'cf-connecting-ip', 'cf-ipcountry', 'cf-visitor',
  'cf-templated-route', 'cf-mitigated', 'cf-warp-tag-id', 'real-ip',
  'x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host', 'x-real-ip',
]);
function forwardHeaders(from: Headers): Headers {
  const out = new Headers();
  from.forEach((v, k) => {
    const lk = k.toLowerCase();
    if (HOP_BY_HOP.has(lk)) return;
    if (lk.startsWith('cf-')) return; // 兜底: 所有 cf-* 都不转发
    out.set(k, v);
  });
  if (!out.has('accept')) out.set('accept', 'application/json');
  return out;
}

/**
 * 解析请求要发送的上游 URL (针对目标账户的解密 key 已注入 header)
 */
function buildUpstreamUrl(acc: Account, meta: RequestMeta, env: Env): string {
  const path = meta.path;
  // 账户可用性: 自定义 base_url 优先
  const base =
    acc.base_url ||
    (acc.provider === 'anthropic'
      ? env.UPSTREAM_ANTHROPIC ?? 'https://api.anthropic.com'
      : env.UPSTREAM_OPENAI ?? 'https://api.openai.com/v1');

  // 处理 /wire/openai/... 前缀
  let rel = path;
  if (rel.startsWith('/wire/openai')) rel = rel.slice('/wire/openai'.length) || '/v1/chat/completions';
  else if (rel.startsWith('/wire/anthropic')) rel = rel.slice('/wire/anthropic'.length) || '/v1/messages';

  // 拼接。若 base 已含版本前缀 (如 https://xxx/v1) 而 rel 又以同一前缀开头,
  // 去重, 避免 /v1/v1/chat/completions 这类 404。
  return composeUpstreamUrl(base, rel);
}

/** base + rel 拼接, 带 /vN 版本前缀去重 (供 /api/models 等复用) */
export function composeUpstreamUrl(base: string, rel: string): string {
  const baseTrimmed = base.replace(/\/+$/, '');
  const vm = baseTrimmed.match(/\/v\d+$/);
  if (vm && (rel === vm[0] || rel.startsWith(vm[0] + '/'))) {
    rel = rel.slice(vm[0].length) || '/';
  }
  return `${baseTrimmed}${rel}`;
}

/** 账户上游的模型列表 URL (openai 兼容: /models; anthropic: /v1/models) */
export function modelsUrlFor(acc: Account, env: Env): string {
  const base =
    acc.base_url ||
    (acc.provider === 'anthropic'
      ? env.UPSTREAM_ANTHROPIC ?? 'https://api.anthropic.com'
      : env.UPSTREAM_OPENAI ?? 'https://api.openai.com/v1');
  const baseTrimmed = base.replace(/\/+$/, '');
  const hasVersion = /\/v\d+$/.test(baseTrimmed);
  return hasVersion ? `${baseTrimmed}/models` : `${baseTrimmed}/v1/models`;
}

/** 账户模型列表请求的鉴权头 */
export function modelsAuthFor(acc: Account): Record<string, string> {
  const key = acc.api_key ?? '';
  if (acc.provider === 'anthropic') {
    return { 'x-api-key': key, 'anthropic-version': '2023-06-01' };
  }
  return { authorization: `Bearer ${key}` };
}

// 提取请求体 token 数 (仅流式/非流式 JSON 简单估算)
function estimateTokens(body?: string): { input: number; output: number; cacheRead: number; cacheCreation: number } {
  const out = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
  if (!body) return out;
  try {
    const parsed = JSON.parse(body);
    const messages = Array.isArray(parsed?.messages) ? parsed.messages : [];
    // 粗略: 每 token 约 4 字符
    let chars = 0;
    for (const m of messages) {
      if (typeof m?.content === 'string') chars += m.content.length;
      else if (Array.isArray(m?.content)) {
        for (const c of m.content) {
          if (typeof c?.text === 'string') chars += c.text.length;
        }
      }
    }
    const sys = Array.isArray(parsed?.system)
      ? parsed.system.map((s: any) => typeof s === 'string' ? s : s?.text ?? '').join('')
      : typeof parsed?.system === 'string' ? parsed.system : '';
    chars += sys.length;
    out.input = Math.ceil(chars / 4);
  } catch {
    out.input = Math.ceil((body?.length ?? 0) / 4);
  }
  return out;
}

/**
 * 主代理入口。返回最终 Response (可能经过 failover)。
 */
export async function proxyRequest(
  env: Env, db: Db, meta: RequestMeta, balancer: LoadBalancer, eligibility: Eligibility,
): Promise<ProxyResult> {
  const started = Date.now();
  // 先加载全部在用账户
  const allAccounts = await db.listAccounts(false);
  if (allAccounts.length === 0) {
    return finalize(db, meta, null, {
      status: 503, success: false, error: 'no accounts configured', ms: Date.now() - started,
      strategy: meta.strategy, decision: 'no_accounts', failover: 0, actualModel: meta.requestedModel,
      provider: null,
    });
  }
  await eligibility.warmUsage(allAccounts);

  // 选出候选 (按优先级)
  const ranked = balancer.rank(allAccounts, meta, eligibility);
  if (ranked.length === 0) {
    return finalize(db, meta, null, {
      status: 503, success: false, error: 'all accounts unavailable (paused or circuit-broken)', ms: Date.now() - started,
      strategy: meta.strategy, decision: 'unavailable', failover: 0, actualModel: meta.requestedModel, provider: null,
    });
  }

  // 故障转移循环: 按候选依次尝试
  let lastErr = '';
  let failover = 0;
  let decision: RouteDecision = {
    strategy: meta.strategy, decision: 'selected', selectedAccountId: ranked[0].id,
    candidatesCount: ranked.length, failoverReason: null, affinityKey: meta.affinityKey ?? null,
  };

  for (let i = 0; i < ranked.length && i <= MAX_FAILOVER; i++) {
    const acc = ranked[i];
    if (i > 0) {
      decision = {
        ...decision, decision: 'failover', selectedAccountId: acc.id,
        failoverReason: `fallback from ${ranked[i - 1].name} (${lastErr})`, failover,
      };
    }

    // 并发准入
    if (acc.max_concurrent > 0) {
      const ok = await acquireSlot(env, acc.id, acc.max_concurrent);
      if (!ok) {
        lastErr = 'concurrency limit';
        failover++;
        continue;
      }
    }

    // 单飞探测: 若该账户熔断期刚过, 只允许一个探测请求
    if (acc.rate_limited_until && acc.rate_limited_until <= Date.now()) {
      const probe = await tryProbe(env, acc.id, acc.rate_limited_until);
      if (!probe.allowed) {
        if (acc.max_concurrent > 0) await releaseSlot(env, acc.id);
        lastErr = 'single-flight probe in progress';
        failover++;
        continue;
      }
    }

    // 构造转发请求 — 只保留安全的端到端头, 剥离 host/content-length/连接类头,
    // 避免 workerd fetch 因重复/不匹配的 content-length 丢连接
    const url = buildUpstreamUrl(acc, meta, env);
    const upstreamHeaders = forwardHeaders(meta.header);
    upstreamHeaders.set('authorization', `Bearer ${acc.api_key}`);
    const init: RequestInit = {
      method: meta.method,
      headers: upstreamHeaders,
      body: meta.method === 'GET' || meta.method === 'HEAD' ? undefined : meta.body,
      redirect: 'follow',
    };

    let upstreamRes: Response;
    let occurred = 0;
    try {
      const t1 = Date.now();
      upstreamRes = await fetchWithFirstByteTimeout(url, init, firstByteTimeoutMs(env, await db.getSetting('timeout_first_byte_seconds')));
      occurred = Date.now() - t1;
    } catch (err: any) {
      const isTimeout = err?.name === 'TimeoutError';
      console.error(`[proxy] fetch to ${url} ${isTimeout ? 'timed out' : 'failed'} for account ${acc.id}: ${err?.message ?? 'unknown'}`);
      if (isTimeout) {
        // 上游卡死: 短暂熔断该账户 (60s), 避免后续请求继续排队等它, 然后 failover 换 key
        const until = Date.now() + FIRST_BYTE_COOLDOWN_MS;
        await circuitBreak(env, acc.id, until, 'first_byte_timeout', 0);
        await db.setRateLimit(acc.id, until, 'first_byte_timeout', (acc.consecutive_rate_limits ?? 0) + 1);
      }
      lastErr = isTimeout ? `timeout: ${err.message}` : `network error: ${err?.message ?? 'unknown'}`;
      if (acc.max_concurrent > 0) await releaseSlot(env, acc.id);
      failover++;
      continue;
    }

    // 成功 (2xx) — 完成 relay 并记录用量
    if (upstreamRes.status >= 200 && upstreamRes.status < 300) {
      if (acc.max_concurrent > 0) await releaseSlot(env, acc.id);
      // 单飞探测成功 -> 清除熔断
      if (acc.rate_limited_until) await probeComplete(env, acc.id, true);
      const final = await relay(env, db, acc, meta, upstreamRes, decision, started, occurred);
      return { ...final, decision };
    }

    // 失败: 429 (限流/熔断) | 5xx (服务端)
    const isRL = upstreamRes.status === 429 || upstreamRes.status === 529;
    lastErr = `upstream_${upstreamRes.status}`;
    if (acc.max_concurrent > 0) await releaseSlot(env, acc.id);

    // 429: 熔断该账户 (cooldown + 单飞探测)
    if (isRL) {
      const retryAfter = parseRetryAfter(upstreamRes, isRL);
      const reason = upstreamRes.status === 429 ? 'upstream_429' : 'upstream_529';
      const until = Date.now() + retryAfter;
      await circuitBreak(env, acc.id, until, reason, upstreamRes.status);
      await db.setRateLimit(acc.id, until, reason, (acc.consecutive_rate_limits ?? 0) + 1);
      await db.pauseAccount(acc.id, 'rate_limit');
    }

    // 读取错误 body (用于 failover 记录)
    try { lastErr = `upstream_${upstreamRes.status}: ` + (await upstreamRes.text()).slice(0, 200); } catch {}
    failover++;

    // 若还剩可用候选, 继续下一轮; 否则返回最后一个错误状态
    if (i === ranked.length - 1 || failover >= MAX_FAILOVER) {
      const resp = new Response(lastErr, { status: 502, headers: { 'content-type': 'text/plain' } });
      // 记录失败请求
      await db.recordRequest({
        id: crypto.randomUUID(), timestamp: started, method: meta.method, path: meta.path,
        account_id: acc.id, provider: acc.provider, requested_model: meta.requestedModel,
        actual_model: meta.requestedModel, status_code: resp.status, success: 0,
        error_message: lastErr, response_time_ms: Date.now() - started,
        failover_attempts: failover, api_key_id: meta.sourceApiKey ?? null,
        strategy: meta.strategy, decision: 'failed', affinity_key: meta.affinityKey ?? null,
      });
      await eligibility.resetSession?.call(eligibility, acc, Date.now()); // 清理粘性避免 pin 到坏账户
      return { response: resp, decision: { ...decision, decision: 'failed' } };
    }
  }

  // 理论不可达, 兜底
  return finalize(db, meta, null, {
    status: 502, success: false, error: lastErr || 'failover exhausted', ms: Date.now() - started,
    strategy: meta.strategy, decision: 'failed', failover, actualModel: meta.requestedModel, provider: null,
  });
}

/**
 * 转发成功响应 / 流到客户端, 并记录 token 用量。
 * 为保持 LLM 流式响应不被缓冲, 这里不读取 body, 而是:
 *  - 若能拿到用法 (headers + 可选 request 里的 stream_options.include_usage), 用之;
 *  - 否则用请求体估算 input token, output 留 0 (流式精确统计属于增强项)。
 *
 * 注意: 流式响应无法在转发前得知 output token, 因此记录的是"请求侧"估算。
 */
async function relay(
  env: Env, db: Db, acc: Account, meta: RequestMeta,
  upstreamRes: Response, decision: RouteDecision, started: number, upstreamMs: number,
): Promise<ProxyResult> {
  // 用量来源 1: 上游响应头 (部分提供商提供 x-usage-* 头)
  const usageFromHeaders = parseUsageFromHeaders(upstreamRes.headers);
  // 用量来源 2: 非流式 JSON 响应 — 解析 body 里的 usage 字段 (OpenAI/Anthropic 标准位置)
  let usageFromBody: { input?: number; output?: number; cacheRead?: number; cacheCreation?: number } = {};
  let bufferedBody: string | null = null;
  const contentType = upstreamRes.headers.get('content-type') ?? '';
  if (contentType.includes('application/json') && !contentType.includes('event-stream')) {
    try {
      bufferedBody = await upstreamRes.text();
      const j = JSON.parse(bufferedBody);
      const u = j?.usage ?? j?.usage_metadata ?? j?.[0]?.usage; // OpenAI / Anthropic / 流式尾包兜底
      if (u) {
        usageFromBody = {
          input: u.prompt_tokens ?? u.input_tokens,
          output: u.completion_tokens ?? u.output_tokens,
          cacheRead: u.prompt_tokens_details?.cached_tokens ?? u.cache_read_input_tokens,
          cacheCreation: u.cache_creation_input_tokens,
        };
      }
    } catch { /* 解析失败则回退估算 */ }
  }
  // 用量来源 3: 请求体估算 input
  const est = estimateTokens(meta.body);

  const pick = (a?: number, b?: number, c?: number) => a ?? b ?? c ?? 0;
  const tokens = {
    input: pick(usageFromBody.input, usageFromHeaders.input, est.input),
    output: pick(usageFromBody.output, usageFromHeaders.output, 0),
    cacheRead: pick(usageFromBody.cacheRead, usageFromHeaders.cacheRead, 0),
    cacheCreation: pick(usageFromBody.cacheCreation, usageFromHeaders.cacheCreation, 0),
  };
  const total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheCreation;

  // 更新 D1 用量窗口 (5h / 7d)
  const u = await db.getUsage(acc.id);
  const now = Date.now();
  const fiveH = 5 * 3600 * 1000;
  const winStart = u?.window5hStart && now - u.window5hStart < fiveH ? u.window5hStart : now;
  const weeklyStart = u?.windowWeeklyStart && now - u.windowWeeklyStart < 7 * 24 * 3600 * 1000 ? u.windowWeeklyStart : now;
  await db.upsertUsage({
    accountId: acc.id,
    window5hStart: winStart,
    update5hTokens: (winStart === now ? 0 : u?.update5hTokens ?? 0) + total,
    windowWeeklyStart: weeklyStart,
    updateWeeklyTokens: (weeklyStart === now ? 0 : u?.updateWeeklyTokens ?? 0) + total,
    lastUpdated: now,
  });

  await db.touchUsed(acc.id, acc.request_count + 1);

  // 记录请求
  await db.recordRequest({
    id: crypto.randomUUID(), timestamp: started, method: meta.method, path: meta.path,
    account_id: acc.id, provider: acc.provider, requested_model: meta.requestedModel,
    actual_model: usageFromHeaders.actualModel ?? meta.requestedModel, status_code: upstreamRes.status, success: 1,
    error_message: null, response_time_ms: Date.now() - started, failover_attempts: 0,
    prompt_tokens: tokens.input, completion_tokens: tokens.output,
    cache_read_tokens: tokens.cacheRead, cache_creation_tokens: tokens.cacheCreation,
    total_tokens: total, api_key_id: meta.sourceApiKey ?? null,
    strategy: meta.strategy, decision: decision.decision, affinity_key: meta.affinityKey ?? null,
  });

  // 中继响应 (保留头部, 移除 hop-by-hop 头)。
  // 非流式 JSON 已被读取用于统计 usage, 用缓冲内容重建; 流式保持零缓冲透传。
  const outHeaders = new Headers(upstreamRes.headers);
  outHeaders.delete('set-cookie');
  if (bufferedBody !== null) {
    // body 已解压重建 — 旧的编码/长度头不再成立
    outHeaders.delete('content-encoding');
    outHeaders.delete('content-length');
  }
  const finalResp = new Response(bufferedBody ?? upstreamRes.body, {
    status: upstreamRes.status,
    headers: outHeaders,
  });
  return { response: finalResp, upstreamMs, decision };
}

// 从响应头提取用量 (避免缓冲流)
const USAGE_HEADER = /x[-_]?usage|anthropic[-_]usage|cf[-_]?usage/i;
function parseUsageFromHeaders(headers: Headers): {
  input?: number; output?: number; cacheRead?: number; cacheCreation?: number; actualModel?: string;
} {
  const out: Record<string, number | string> = {};
  headers.forEach((v, k) => {
    const lk = k.toLowerCase();
    if (lk.includes('prompt_tokens') || lk.includes('input_tokens')) out.input = parseInt(v, 10) || 0;
    else if (lk.includes('completion_tokens') || lk.includes('output_tokens')) out.output = parseInt(v, 10) || 0;
    else if (lk.includes('cached_tokens')) out.cacheRead = parseInt(v, 10) || 0;
    else if (lk.includes('cache_creation')) out.cacheCreation = parseInt(v, 10) || 0;
  });
  return out as any;
}

function parseRetryAfter(res: Response, isRL: boolean): number {
  const ra = res.headers.get('retry-after');
  if (ra) {
    const secs = parseInt(ra, 10);
    if (!Number.isNaN(secs)) return Math.min(secs * 1000, 60 * 60 * 1000); // cap 1h
    const d = new Date(ra).getTime();
    if (!Number.isNaN(d)) return Math.min(Math.max(0, d - Date.now()), 60 * 60 * 1000);
  }
  // 默认: 429 60s, 529 30s
  return isRL ? 60_000 : 30_000;
}

async function finalize(
  db: Db, meta: RequestMeta, acc: Account | null, o: {
    status: number; success: boolean; error: string; ms: number; strategy: string; decision: string;
    failover: number; actualModel?: string | null; provider?: string | null;
  },
): Promise<ProxyResult> {
  await db.recordRequest({
    id: crypto.randomUUID(), timestamp: Date.now() - o.ms, method: meta.method, path: meta.path,
    account_id: acc?.id ?? null, provider: acc?.provider ?? o.provider ?? null,
    requested_model: meta.requestedModel, actual_model: o.actualModel ?? meta.requestedModel,
    status_code: o.status, success: o.success ? 1 : 0, error_message: o.error,
    response_time_ms: o.ms, failover_attempts: o.failover,
    api_key_id: meta.sourceApiKey ?? null, strategy: o.strategy, decision: o.decision,
    affinity_key: meta.affinityKey ?? null,
  });
  const resp = new Response(JSON.stringify({ error: o.error }), {
    status: o.status, headers: { 'content-type': 'application/json' },
  });
  return { response: resp };
}

export { buildUpstreamUrl, estimateTokens };