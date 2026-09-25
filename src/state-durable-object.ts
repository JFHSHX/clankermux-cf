// PoolState — Durable Object
//
// 职责:
//  1. 429/529 熔断 cooldown: 收到上游 429/529 后把账户标记为 rate_limited_until,
//     并通过 alarm 在 cooldown 到期时自动解除。这是跨请求共享的可变状态,
//     必须住在 DO 里 (Worker 无状态, 每次请求可能是新实例)。
//  2. 单飞探测 (single-flight): 当某账户熔断期结束, 只允许一个探测请求去验证
//     它是否已恢复, 避免并发客户端在 cooldown 到期瞬间一起轰击上游。
//  3. 用量/利用率快照: FEFO 需要的有效利用率计数。D1 存持久值, DO 内存维护
//     高速计数以减少 D1 写放大。
//  4. 并发准入 (max_concurrent): 限制单账户同时在途请求数; 0 = 不限。
//
// 分片: 单 key 池规模小 (几十个 key), 用一个 DO 实例持有全部状态即可。
// 若未来账户量大, 可按 accountId 哈希分片多个 DO generic 实例, 这里保留单一
// 实例的简单实现 (single-instance DO, Cloudflare 保证同 key 串行执行)。

import type { DurableObjectState } from '@cloudflare/workers-types';

// 请求/响应内部协议 — 用 fetch 到 DO, body 携带子命令
type Inbound =
  | { cmd: 'circuit_break'; accountId: string; until: number; reason: string; status: number }
  | { cmd: 'try_probe'; accountId: string; cooldownUntil: number }
  | { cmd: 'probe_complete'; accountId: string; recovered: boolean }
  | { cmd: 'acquire_slot'; accountId: string; maxConcurrent: number }
  | { cmd: 'release_slot'; accountId: string }
  | { cmd: 'snapshot'; accountId?: string }
  | { cmd: 'reset_all' };

interface CircuitState {
  until: number;
  reason: string;
  status: number;
  // 单飞探测进行中 (cooldown 已到期但探测还没返回)
  probing: boolean;
  // 并发槽占用
  inFlight: number;
}

export class PoolState {
  private state: DurableObjectState;
  private circuits = new Map<string, CircuitState>();
  // 内存用量计数器: accountId -> { 5h token 累加, 5h 窗口起点 }
  private usage = new Map<string, { winStart: number; tokens: number }>();
  private static WIN_5H = 5 * 3600 * 1000;
  private static PROBE_TIMEOUT_MS = 30_000;

  constructor(state: DurableObjectState, env: unknown) {
    this.state = state;
    // 从持久 KV 恢复熔断状态 (DO 重启后不丢失)
    void state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.get<Record<string, CircuitState>>('circuits');
      if (stored) this.circuits = new Map(Object.entries(stored));
    });
  }

  async fetch(request: Request): Promise<Response> {
    const body = (await request.json()) as Inbound;
    switch (body.cmd) {
      case 'circuit_break': {
        const c: CircuitState = {
          until: body.until,
          reason: body.reason,
          status: body.status,
          probing: false,
          inFlight: this.circuits.get(body.accountId)?.inFlight ?? 0,
        };
        this.circuits.set(body.accountId, c);
        this.persist();
        // 计划一个 alarm 在 cooldown 到期后触发 (自动解除 + 允许探测)
        await this.state.storage.setAlarm(body.until + 1);
        return json({ ok: true });
      }
      case 'try_probe': {
        const c = this.circuits.get(body.accountId);
        // DO 无该账户的熔断记录 -> 直接允许 (D1 侧的 rate_limited_until 过期值
        // 不构成有效熔断; 返回拒绝会让账户永久卡死, 无任何恢复路径)
        if (!c) {
          return json({ allowed: true, reason: 'clear' });
        }
        // cooldown 未到期 -> 不可探测
        if (Date.now() < c.until) {
          return json({ allowed: false, reason: 'cooldown' });
        }
        // 已有探测在途 -> 拒绝 (单飞)
        if (c.probing) {
          return json({ allowed: false, reason: 'inflight' });
        }
        // cooldown 到期, 允许一次探测, 标记 probing
        c.probing = true;
        this.circuits.set(body.accountId, c);
        this.persist();
        // 探测超时兜底: 若 30s 内 probe_complete 没来, 强制释放
        await this.state.storage.setAlarm(Date.now() + PoolState.PROBE_TIMEOUT_MS);
        return json({ allowed: true, reason: 'probe' });
      }
      case 'probe_complete': {
        const c = this.circuits.get(body.accountId);
        if (!c) return json({ ok: true });
        if (body.recovered) {
          // 恢复: 清除熔断状态
          this.circuits.delete(body.accountId);
          this.persist();
        } else {
          // 未恢复: 延长阻断 (指数退避), 重新排 alarm
          const nextUntil = Date.now() + 60_000; // 基础退避 60s
          c.until = nextUntil;
          c.probing = false;
          this.circuits.set(body.accountId, c);
          this.persist();
          await this.state.storage.setAlarm(nextUntil + 1);
        }
        return json({ ok: true });
      }
      case 'acquire_slot': {
        const c = this.circuits.get(body.accountId);
        const inFlight = c?.inFlight ?? 0;
        if (body.maxConcurrent > 0 && inFlight >= body.maxConcurrent) {
          return json({ allowed: false });
        }
        if (c) {
          c.inFlight = inFlight + 1;
          this.circuits.set(body.accountId, c);
        } else {
          this.circuits.set(body.accountId, {
            until: 0, reason: '', status: 0, probing: false, inFlight: 1,
          });
        }
        return json({ allowed: true });
      }
      case 'release_slot': {
        const c = this.circuits.get(body.accountId);
        if (c) {
          c.inFlight = Math.max(0, (c.inFlight ?? 0) - 1);
          if (c.inFlight === 0 && !c.until && !c.probing) {
            this.circuits.delete(body.accountId);
          } else {
            this.circuits.set(body.accountId, c);
          }
        }
        return json({ ok: true });
      }
      case 'snapshot': {
        const target = body.accountId
          ? new Map([[body.accountId, this.circuits.get(body.accountId)]])
          : this.circuits;
        const out: Record<string, Record<string, unknown>> = {};
        for (const [k, v] of target) {
          if (v) out[k] = { ...v };
        }
        return json({ circuits: out, usage: Object.fromEntries(this.usage) });
      }
      case 'reset_all': {
        this.circuits.clear();
        this.usage.clear();
        this.persist();
        return json({ ok: true });
      }
      default:
        return json({ error: 'unknown cmd' }, 400);
    }
  }

  // alarm: cooldown 到期自动触发。这里我们不需要额外动作, 因为 Worker 侧在选择
  // 账户时已经会查询 DO 状态; alarm 主要用于清空过时 min 状态 + 触发 probing 重置。
  async alarm(): Promise<void> {
    const now = Date.now();
    let changed = false;
    for (const [id, c] of this.circuits) {
      // 若 cooldown 已到期 且 没有在途探测, 移除 (下次请求自然可探测)
      if (c.until > 0 && now >= c.until && !c.probing && c.inFlight === 0) {
        this.circuits.delete(id);
        changed = true;
      }
      // 若 probing 超时, 重置为可探测
      else if (c.probing && c.until > 0 && now >= c.until + PoolState.PROBE_TIMEOUT_MS) {
        c.probing = false;
        this.circuits.set(id, c);
        changed = true;
      }
    }
    if (changed) this.persist();
    // 重新排下一次 alarm 到最近的未来到期项
    let next = 0;
    for (const c of this.circuits.values()) {
      const target = c.probing ? c.until + PoolState.PROBE_TIMEOUT_MS : c.until;
      if (target > now && (next === 0 || target < next)) next = target;
    }
    if (next > now) await this.state.storage.setAlarm(next + 1);
  }

  private persist(): void {
    // 异步持久化 (不等待)
    void this.state.storage.put('circuits', Object.fromEntries(this.circuits));
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}