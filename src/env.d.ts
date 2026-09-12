// Worker 运行时环境类型定义 (bindings)
import type { D1Database, DurableObjectNamespace, ExecutionContext } from '@cloudflare/workers-types';

export type Env = {
  DB: D1Database;
  POOL_STATE: DurableObjectNamespace;
  ASSETS: Fetcher;
  // 可选配置 (vars / secrets)
  DASHBOARD_PASSWORD?: string;
  DEFAULT_PROVIDER?: string;
  UPSTREAM_OPENAI?: string;
  UPSTREAM_ANTHROPIC?: string;
  // ---- 默认轮换策略 ----
  STRATEGY?: string;          // fefo | roundrobin | weighted | session
  LB_SESSION_DURATION_HOURS?: string;
};

export type RouteContext = {
  env: Env;
  executionCtx: ExecutionContext;
};

// Durable Object 绑定接口
export interface DurableObjectStub {
  fetch(input: RequestInfo | string, init?: RequestInit): Promise<Response>;
  id: DurableObjectId;
  name?: string;
}