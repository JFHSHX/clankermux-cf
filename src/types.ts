// 核心领域类型

export type ProviderName = 'openai' | 'anthropic' | 'openrouter' | 'custom';

export interface Account {
  id: string;
  name: string;
  provider: ProviderName;
  base_url?: string | null;
  api_key?: string | null;
  enc_key?: string | null;
  created_at: number;
  last_used?: number | null;
  request_count: number;
  total_requests: number;
  priority: number;
  weight: number;
  paused: number;
  pause_reason?: string | null;
  rate_limited_until?: number | null;
  rate_limited_reason?: string | null;
  rate_limited_at?: number | null;
  consecutive_rate_limits: number;
  session_start?: number | null;
  session_request_count: number;
  auto_fallback: number;
  max_concurrent: number;
  model_mappings?: string | null;
  custom_headers?: string | null;
  notes?: string | null;
  disabled: number;
}

// 转发请求的元数据
export interface RequestMeta {
  path: string;
  method: string;
  requestedModel?: string | null;
  project?: string | null;
  affinityKey?: string | null;
  sourceApiKey?: string | null; // 下游 proxy key
  header: Headers;
  body: string;
  strategy: LoadBalancingStrategy;
}

export type LoadBalancingStrategy = 'fefo' | 'roundrobin' | 'weighted' | 'session';

export interface RouteDecision {
  strategy: string;
  decision: string;
  selectedAccountId: string | null;
  candidatesCount: number;
  failoverReason: string | null;
  affinityKey: string | null;
  failover?: number;
}

// 账户有效性快照 (传入策略)
export interface AccountEligibility {
  /** 是否可用 (未暂停 / 未熔断 / 窗口未耗尽) */
  available(acc: Account, now: number): boolean;
  /** 当前有效利用率 0-100 (FEFO/least-used 依据) */
  utilization(acc: Account, now: number): number;
  /** 账户容量信息 (FEFO 桶) — 可空实现 */
  capacity?(acc: Account, now: number): AccountCapacity;
  /** 记录一次命中 (策略内部可维护 recency 惩罚) */
  onSelected?(acc: Account, now: number): void;
  /** 会话重置 (session 策略) */
  resetSession?(acc: Account, now: number): void;
  /** 记录 429 熔断 (由代理在收到 429 时回调) */
  onRateLimited?(acc: Account, until: number, reason: string): void;
}

export interface AccountCapacity {
  bucket: 'harvest' | 'unknown' | 'near_limit';
  /** 最近重置截止 (harvest 排序) */
  resetDeadline: number;
  /** 剩余可用 token 比例 0-1 */
  headroom: number;
  /** 是否接近上限 */
  nearLimit: boolean;
}

// 策略接口
export interface LoadBalancer {
  readonly name: string;
  /** 返回按优先顺序排列的候选账户 (第一个为主候选)。agents: 可用账户快照 */
  rank(
    accounts: Account[],
    meta: RequestMeta,
    eligibility: AccountEligibility,
    now?: number,
  ): Account[];
}

// 用量窗口 (FEFO 利用率来源)
export interface UsageWindow {
  accountId: string;
  window5hStart: number | null;
  update5hTokens: number;
  windowWeeklyStart: number | null;
  updateWeeklyTokens: number;
  lastUpdated: number | null;
}

export const ANTHROPIC_SESSION_DURATION_DEFAULT_HOURS = 5;
export const RATE_LIMIT_REASONS = {
  UPSTREAM_429: 'upstream_429',
  UPSTREAM_529: 'upstream_529',
  EXHAUSTION: 'exhaustion',
} as const;

export const PROVIDER_NAMES: Record<ProviderName, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  openrouter: 'OpenRouter',
  custom: 'OpenAI-compatible',
};

export const DEFAULT_UPSTREAM: Record<ProviderName, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  openrouter: 'https://openrouter.ai/api/v1',
  custom: '',
};