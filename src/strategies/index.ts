// 负载均衡策略实现
import type { Account, LoadBalancer, RequestMeta, AccountEligibility } from '../types';

// 最近命中惩罚窗口: 被选中的账户在窗口内获得高惩罚分数,
// 使并发突发轮换到其它账户而非全部涌向同一最低利用账户 (FEFO 核心)。
const RECENT_PICK_WINDOW_MS = 500;
const RECENT_PICK_PENALTY = 100;

/**
 * FEFO (First-Expiring, First-Out) — 用户选的默认策略。
 * 有效排序依据:
 *   1. priority (越小越优先)
 *   2. 容量桶: harvest(有重置截止) < unknown(无数据) < near_limit(将耗尽)
 *   3. harvest 桶内按"最早到期者先服务" (FEFO), 其次最低利用率
 *   4. 最近命中惩罚使突发轮换
 */
export class FefoStrategy implements LoadBalancer {
  readonly name = 'fefo';
  private lastPickedAt = new Map<string, number>();

  rank(accounts: Account[], _meta: RequestMeta, e: AccountEligibility, now = Date.now()): Account[] {
    const available = accounts.filter((a) => e.available(a, now));
    if (available.length === 0) return [];

    const scored = available.map((a) => {
      const util = e.utilization(a, now);
      const cap = e.capacity ? e.capacity(a, now) : null;
      const lastPick = this.lastPickedAt.get(a.id) ?? 0;
      const recency = now - lastPick < RECENT_PICK_WINDOW_MS ? RECENT_PICK_PENALTY : 0;
      return { acc: a, util, cap, recency };
    });

    scored.sort((x, y) => {
      if (x.acc.priority !== y.acc.priority) return x.acc.priority - y.acc.priority;
      // 仅硬性避开将耗尽的账户; harvest/unknown 不再字典序压制,
      // 否则首个收到流量的账户会被永久钉死 (鸡生蛋问题)。
      const xn = x.cap?.nearLimit ? 1 : 0;
      const yn = y.cap?.nearLimit ? 1 : 0;
      if (xn !== yn) return xn - yn;
      const s = (x.util + x.recency) - (y.util + y.recency);
      if (s !== 0) return s;
      // 平票: FEFO — 最早到期 (reset deadline 最近) 者先服务
      return (x.cap?.resetDeadline ?? Infinity) - (y.cap?.resetDeadline ?? Infinity);
    });

    const primary = scored[0].acc;
    this.lastPickedAt.set(primary.id, now);
    // 清理过期记录
    const gc = now - RECENT_PICK_WINDOW_MS * 10;
    for (const [id, ts] of this.lastPickedAt) if (ts < gc) this.lastPickedAt.delete(id);

    return scored.map((s) => s.acc);
  }
}

/** 轮询 — 均匀分摊, 无粘性 */
export class RoundRobinStrategy implements LoadBalancer {
  readonly name = 'roundrobin';
  private cursor = 0;

  rank(accounts: Account[], _meta: RequestMeta, e: AccountEligibility, now = Date.now()): Account[] {
    const available = accounts.filter((a) => e.available(a, now));
    if (available.length === 0) return [];
    // 从游标环形取
    const start = this.cursor % available.length;
    this.cursor = (start + 1) % available.length;
    return [...available.slice(start), ...available.slice(0, start)];
  }
}

/** 加权 — 按 weight 概率分布 (weight 越大命中率越高), 加权轮询 */
export class WeightedStrategy implements LoadBalancer {
  readonly name = 'weighted';
  private lastPickedAt = new Map<string, number>();
  private static RECENT_WINDOW = 500;
  private static RECENT_PENALTY = 100_000;

  rank(accounts: Account[], _meta: RequestMeta, e: AccountEligibility, now = Date.now()): Account[] {
    const available = accounts.filter((a) => e.available(a, now));
    if (available.length === 0) return [];
    const totalWeight = available.reduce((s, a) => s + Math.max(0.001, a.weight), 0);
    const weighted = available.map((a) => ({
      acc: a,
      // 按权重生成排序键: 权重占比越大, 排得越靠前 (近似加权概率)
      span: Math.max(0.001, a.weight) / totalWeight,
      recency: now - (this.lastPickedAt.get(a.id) ?? 0) < WeightedStrategy.RECENT_WINDOW
        ? WeightedStrategy.RECENT_PENALTY : 0,
    }));
    weighted.sort((x, y) => {
      if (x.acc.priority !== y.acc.priority) return x.acc.priority - y.acc.priority;
      return y.span - x.span;
    });
    // 最近命中惩罚优先于权重差 (跨度差异 < penalty 时轮换)
    weighted.sort((x, y) => {
      const px = x.acc.priority, py = y.acc.priority;
      if (px !== py) return px - py;
      return x.recency - y.recency || y.span - x.span;
    });
    const primary = weighted[0].acc;
    this.lastPickedAt.set(primary.id, now);
    return weighted.map((w) => w.acc);
  }
}

/**
 * Session — 5h 会话粘性 + prompt-cache affinity。
 * 同一项目(affinityKey) 的请求尽量固定在初始选择的账户上,
 * 以便复用上游 prompt cache; 熔断/耗尽时自动 reassign。
 */
export class SessionStrategy implements LoadBalancer {
  readonly name = 'session';
  private affinity = new Map<string, { accountId: string; lastUsed: number }>();
  private durationMs: number;

  constructor(durationHours = 5) {
    this.durationMs = durationHours * 3600 * 1000;
  }

  rank(accounts: Account[], meta: RequestMeta, e: AccountEligibility, now = Date.now()): Account[] {
    const available = accounts.filter((a) => e.available(a, now));
    if (available.length === 0) return [];

    // 清理过期 affinity
    for (const [k, v] of this.affinity) if (now - v.lastUsed > this.durationMs) this.affinity.delete(k);

    const key = meta.affinityKey?.trim() ?? meta.project?.trim() ?? null;
    if (key) {
      const entry = this.affinity.get(key);
      if (entry) {
        const pinned = available.find((a) => a.id === entry.accountId);
        if (pinned) {
          // affinity 命中: 固定账户优先, 后接其它候选 (若 fixed 账户短时熔断可 fallback)
          this.affinity.set(key, { accountId: pinned.id, lastUsed: now });
          return [pinned, ...available.filter((a) => a.id !== pinned.id)];
        }
        // 原 pin 账户不可用 / 已移除 -> reassign
        this.affinity.delete(key);
      }
      // 新 affinity: 记录并返回当前最优 (复用 FEFO 排序取 primary 作为新锚点)
      const ranked = available
        .slice()
        .sort((a, b) => e.utilization(a, now) - e.utilization(b, now) || a.priority - b.priority);
      this.affinity.set(key, { accountId: ranked[0].id, lastUsed: now });
      return ranked;
    }
    // 无 affinityKey: 用全局会话锚点 (session_start), 无则按利用率
    const withSession = available
      .filter((a) => a.session_start && now - a.session_start < this.durationMs && isSessionActive(a, now, e))
      .sort((a, b) => a.priority - b.priority);
    if (withSession.length > 0) {
      // 已有活跃会话, 沿用最近会话的账户; 否则补排序
      const candidate = withSession.sort((a, b) => (b.session_request_count ?? 0) - (a.session_request_count ?? 0))[0];
      return [candidate, ...available.filter((a) => a.id !== candidate.id)];
    }
    const sorted = available.slice().sort((a, b) => e.utilization(a, now) - e.utilization(b, now) || a.priority - b.priority);
    e.resetSession?.(sorted[0], now);
    return sorted;
  }
}

function isSessionActive(acc: Account, now: number, e: AccountEligibility): boolean {
  return !!acc.session_start && e.available(acc, now);
}

// 工厂
export function buildBalancer(strategy: string, durationHours?: number): LoadBalancer {
  switch (strategy) {
    case 'roundrobin': return new RoundRobinStrategy();
    case 'weighted': return new WeightedStrategy();
    case 'session': return new SessionStrategy(durationHours);
    case 'fefo':
    default: return new FefoStrategy();
  }
}