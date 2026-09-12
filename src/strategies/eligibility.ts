// 账户有效性判定 + FEFO 利用率计算
import type { Account, AccountEligibility, AccountCapacity, UsageWindow } from '../types';
import type { Db } from '../lib/db';

// 熔断 cooldown 短于此值视为"瞬态节流" (保留 prompt cache, 不视为耗尽)
export const TRANSIENT_COOLDOWN_MS = 15 * 60 * 1000;

// 5h 窗口 token 预算估算 — 简化: 500k token/5h 近似 Anthropic 免费档额度。
// FEFO 利用率 = 该账户 5h 窗口已用 token / 预算。
const DEFAULT_5H_TOKEN_BUDGET = 500_000;
const DEFAULT_WEEKLY_TOKEN_BUDGET = 3_500_000;

export class Eligibility implements AccountEligibility {
  private usageCache = new Map<string, UsageWindow>();
  private budget5h: number;
  private budgetWeekly: number;

  constructor(private db: Db, opts?: { budget5h?: number; budgetWeekly?: number }) {
    this.budget5h = opts?.budget5h ?? DEFAULT_5H_TOKEN_BUDGET;
    this.budgetWeekly = opts?.budgetWeekly ?? DEFAULT_WEEKLY_TOKEN_BUDGET;
  }

  async warmUsage(accounts: Account[]): Promise<void> {
    await Promise.all(
      accounts.map(async (a) => {
        if (!this.usageCache.has(a.id)) {
          const u = await this.db.getUsage(a.id);
          this.usageCache.set(a.id, u ?? { accountId: a.id, window5hStart: null, update5hTokens: 0, windowWeeklyStart: null, updateWeeklyTokens: 0, lastUpdated: null });
        }
      }),
    );
  }

  getUsage(accountId: string): UsageWindow | null {
    return this.usageCache.get(accountId) ?? null;
  }

  available(acc: Account, now: number): boolean {
    if (acc.disabled) return false;
    if (acc.paused) return false;
    if (!acc.api_key && !acc.enc_key) return false; // 无凭据不可用
    if (acc.rate_limited_until && acc.rate_limited_until > now) return false; // 熔断中
    return true;
  }

  /**
   * FEFO 利用率: 基于 5h 窗口的实际 token 用量。新账户 (无用量) 返回 0,
   * 使其优先于已耗尽的账户。
   */
  utilization(acc: Account, now: number): number {
    const u = this.getUsage(acc.id);
    if (!u || !u.window5hStart) return 0;
    // 窗口已滚动 -> 重置为 0
    if (now - u.window5hStart > 5 * 3600 * 1000) return 0;
    const used = Math.min(u.update5hTokens, this.budget5h);
    return (used / this.budget5h) * 100;
  }

  /**
   * FEFO 容量桶:
   *  - harvest: 知道重置截止日期且有健康 headroom, 最早到期者先服务
   *  - unknown: 无可用的容量模型 (无用量数据), 按最低利用率
   *  - near_limit: 接近耗尽, 最后服务
   */
  capacity(acc: Account, now: number): AccountCapacity {
    const u = this.getUsage(acc.id);
    if (!u || !u.window5hStart) {
      return { bucket: 'unknown', resetDeadline: Infinity, headroom: 1, nearLimit: false };
    }
    if (now - u.window5hStart > 5 * 3600 * 1000) {
      return { bucket: 'harvest', resetDeadline: u.window5hStart + 5 * 3600 * 1000, headroom: 1, nearLimit: false };
    }
    const used = u.update5hTokens;
    const headroom = Math.max(0, 1 - used / this.budget5h);
    const nearLimit = used / this.budget5h > 0.9;
    return {
      bucket: nearLimit ? 'near_limit' : 'harvest',
      resetDeadline: u.window5hStart + 5 * 3600 * 1000,
      headroom,
      nearLimit,
    };
  }

  resetSession(acc: Account, now: number): void {
    void this.db.setSessionStart(acc.id, now);
    acc.session_start = now;
    acc.session_request_count = 0;
  }
}

// 手写简易陷阱: 不依赖第三方, 移除非白名单 provider 的编码
export function isSessionTrackedProvider(provider: string): boolean {
  return provider === 'anthropic'; // 仅 Anthropic 5h 会话粘性有实际收益
}