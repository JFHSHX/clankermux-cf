// Durable Object 客户端 — Worker 侧包装
import type { Env } from '../env.d';
import type { AccountEligibility, Account } from '../types';

// 通过 DO 分片 id 获取 stub
function stub(env: Env): DurableObjectStub {
  const id = env.POOL_STATE.idFromName('pool');
  return env.POOL_STATE.get(id) as unknown as DurableObjectStub;
}

async function send(env: Env, body: Record<string, unknown>): Promise<any> {
  const s = stub(env);
  const res = await s.fetch('https://do.invalid/', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return res.json();
}

// 熔断状态快照
export async function snapshotAll(env: Env): Promise<Record<string, any>> {
  return send(env, { cmd: 'snapshot' });
}

// 触发一个账户的熔断
export async function circuitBreak(
  env: Env, accountId: string, until: number, reason: string, status: number,
): Promise<void> {
  await send(env, { cmd: 'circuit_break', accountId, until, reason, status });
}

// 尝试获取单飞探测许可 (熔断恢复探测)
export async function tryProbe(
  env: Env, accountId: string, cooldownUntil: number,
): Promise<{ allowed: boolean; reason: string }> {
  return send(env, { cmd: 'try_probe', accountId, cooldownUntil });
}

export async function probeComplete(
  env: Env, accountId: string, recovered: boolean,
): Promise<void> {
  await send(env, { cmd: 'probe_complete', accountId, recovered });
}

// 并发槽
export async function acquireSlot(env: Env, accountId: string, maxConcurrent: number): Promise<boolean> {
  const r = await send(env, { cmd: 'acquire_slot', accountId, maxConcurrent });
  return r.allowed === true;
}

export async function releaseSlot(env: Env, accountId: string): Promise<void> {
  await send(env, { cmd: 'release_slot', accountId });
}

export async function doResetAll(env: Env): Promise<void> {
  await send(env, { cmd: 'reset_all' });
}

// 从 DO 加载各账户熔断状态, 合并进数据库账户行, 供策略使用
export async function attachCircuitState(
  env: Env, accounts: Account[],
): Promise<Account[]> {
  const snap: any = await send(env, { cmd: 'snapshot' });
  const circuits = snap?.circuits ?? {};
  for (const acc of accounts) {
    const c = circuits[acc.id];
    if (c && c.until) {
      acc.rate_limited_until = c.until;
      acc.rate_limited_reason = c.reason;
    }
  }
  return accounts;
}