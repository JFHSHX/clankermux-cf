// D1 数据访问层 — 账户 / 请求 / 设置 / proxy key
import type { D1Database, D1Result } from '@cloudflare/workers-types';
import type { Account, UsageWindow } from '../types';

export class Db {
  constructor(private db: D1Database) {}

  // ---------- accounts ----------
  async listAccounts(includeDisabled = false): Promise<Account[]> {
    const where = includeDisabled ? '' : 'WHERE disabled = 0';
    const res = await this.db
      .prepare(`SELECT * FROM accounts ${where} ORDER BY priority ASC, name ASC`)
      .all<Account>();
    return res.results ?? [];
  }

  async getAccount(id: string): Promise<Account | null> {
    const res = await this.db.prepare('SELECT * FROM accounts WHERE id = ?').bind(id).first<Account>();
    return res ?? null;
  }

  async createAccount(a: Partial<Account> & { id: string; name: string }): Promise<void> {
    const now = Date.now();
    await this.db
      .prepare(
        `INSERT INTO accounts (id, name, provider, base_url, api_key, enc_key, created_at, priority, weight,
          paused, auto_fallback, max_concurrent, model_mappings, custom_headers, notes,
          request_count, total_requests, session_request_count, consecutive_rate_limits, disabled)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        a.id,
        a.name,
        a.provider ?? 'openai',
        a.base_url ?? null,
        a.api_key ?? null,
        a.enc_key ?? null,
        now,
        a.priority ?? 0,
        a.weight ?? 1.0,
        a.paused ?? 0,
        a.auto_fallback ?? 1,
        a.max_concurrent ?? 0,
        a.model_mappings ?? null,
        a.custom_headers ?? null,
        a.notes ?? null,
        0,
        0,
        0,
        0,
        a.disabled ?? 0,
      )
      .run();
  }

  async updateAccount(id: string, patch: Partial<Account>): Promise<void> {
    const fields: string[] = [];
    const values: unknown[] = [];
    const allowed = [
      'name', 'provider', 'base_url', 'api_key', 'enc_key', 'priority', 'weight',
      'paused', 'pause_reason', 'auto_fallback', 'max_concurrent', 'model_mappings',
      'custom_headers', 'notes', 'disabled',
    ] as const;
    for (const k of allowed) {
      if (k in patch && (patch as Record<string, unknown>)[k] !== undefined) {
        fields.push(`${k} = ?`);
        values.push((patch as Record<string, unknown>)[k]);
      }
    }
    if (fields.length === 0) return;
    values.push(id);
    await this.db.prepare(`UPDATE accounts SET ${fields.join(', ')} WHERE id = ?`).bind(...values).run();
  }

  async deleteAccount(id: string): Promise<void> {
    await this.db.prepare('DELETE FROM accounts WHERE id = ?').bind(id).run();
  }

  async softDeleteAccount(id: string): Promise<void> {
    await this.db.prepare('UPDATE accounts SET disabled = 1 WHERE id = ?').bind(id).run();
  }

  async touchUsed(id: string, requestCount: number): Promise<void> {
    const now = Date.now();
    await this.db
      .prepare(
        `UPDATE accounts SET last_used = ?, request_count = ?, total_requests = total_requests + 1,
         session_request_count = session_request_count + 1 WHERE id = ?`,
      )
      .bind(now, requestCount, id)
      .run();
  }

  async setRateLimit(id: string, until: number | null, reason: string | null, consecutive: number): Promise<void> {
    await this.db
      .prepare(
        `UPDATE accounts SET rate_limited_until = ?, rate_limited_reason = ?, rate_limited_at = ?,
         consecutive_rate_limits = ? WHERE id = ?`,
      )
      .bind(until, reason, until ? Date.now() : null, consecutive, id)
      .run();
  }

  async pauseAccount(id: string, reason: string): Promise<void> {
    await this.db.prepare('UPDATE accounts SET paused = 1, pause_reason = ? WHERE id = ?').bind(reason, id).run();
  }

  async resumeAccount(id: string): Promise<void> {
    await this.db
      .prepare('UPDATE accounts SET paused = 0, pause_reason = NULL, rate_limited_until = NULL, consecutive_rate_limits = 0 WHERE id = ?')
      .bind(id)
      .run();
  }

  async setSessionStart(id: string, now: number): Promise<void> {
    await this.db.prepare('UPDATE accounts SET session_start = ?, session_request_count = 0 WHERE id = ?').bind(now, id).run();
  }

  async setEncKey(id: string, encKey: string, apiKeyCleared: boolean): Promise<void> {
    if (apiKeyCleared) {
      await this.db.prepare('UPDATE accounts SET enc_key = ?, api_key = NULL WHERE id = ?').bind(encKey, id).run();
    } else {
      await this.db.prepare('UPDATE accounts SET enc_key = ? WHERE id = ?').bind(encKey, id).run();
    }
  }

  // ---------- requests ----------
  async recordRequest(r: Record<string, unknown>): Promise<void> {
    await this.db
      .prepare(
        `INSERT OR IGNORE INTO requests (id, timestamp, method, path, account_id, provider, requested_model,
          actual_model, status_code, success, error_message, response_time_ms, failover_attempts,
          prompt_tokens, completion_tokens, cache_read_tokens, cache_creation_tokens, total_tokens,
          api_key_id, strategy, decision, affinity_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        r.id,
        r.timestamp,
        r.method,
        r.path,
        r.account_id ?? null,
        r.provider ?? null,
        r.requested_model ?? null,
        r.actual_model ?? null,
        r.status_code ?? null,
        r.success ?? null,
        r.error_message ?? null,
        r.response_time_ms ?? null,
        r.failover_attempts ?? 0,
        r.prompt_tokens ?? 0,
        r.completion_tokens ?? 0,
        r.cache_read_tokens ?? 0,
        r.cache_creation_tokens ?? 0,
        r.total_tokens ?? 0,
        r.api_key_id ?? null,
        r.strategy ?? null,
        r.decision ?? null,
        r.affinity_key ?? null,
      )
      .run();
  }

  // ---------- usage ----------
  async getUsage(accountId: string): Promise<UsageWindow | null> {
    const res = await this.db.prepare('SELECT * FROM usage WHERE account_id = ?').bind(accountId).first<UsageWindow>();
    return res ?? null;
  }

  async upsertUsage(u: UsageWindow): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO usage (account_id, window_5h_start, update_5h_tokens, window_weekly_start, update_weekly_tokens, last_updated)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(account_id) DO UPDATE SET
           window_5h_start = excluded.window_5h_start,
           update_5h_tokens = excluded.update_5h_tokens,
           window_weekly_start = excluded.window_weekly_start,
           update_weekly_tokens = excluded.update_weekly_tokens,
           last_updated = excluded.last_updated`,
      )
      .bind(u.accountId, u.window5hStart, u.update5hTokens, u.windowWeeklyStart, u.updateWeeklyTokens, u.lastUpdated)
      .run();
  }

  // ---------- settings ----------
  async getSetting(key: string): Promise<string | null> {
    const res = await this.db.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first<{ value: string }>();
    return res?.value ?? null;
  }

  async setSetting(key: string, value: string): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .bind(key, value, Date.now())
      .run();
  }

  async getAllSettings(): Promise<Record<string, string>> {
    const res = await this.db.prepare('SELECT key, value FROM settings').all<{ key: string; value: string }>();
    const out: Record<string, string> = {};
    for (const r of res.results ?? []) out[r.key] = r.value;
    return out;
  }

  // ---------- proxy keys ----------
  async listProxyKeys(): Promise<Array<Record<string, unknown>>> {
    const res = await this.db.prepare('SELECT * FROM proxy_keys ORDER BY created_at DESC').all();
    return res.results ?? [];
  }

  async getProxyKeyByHash(hash: string): Promise<Record<string, unknown> | null> {
    const res = await this.db.prepare('SELECT * FROM proxy_keys WHERE key_hash = ?').bind(hash).first();
    return res ?? null;
  }

  async createProxyKey(p: { id: string; name: string; keyHash: string; note?: string }): Promise<void> {
    await this.db
      .prepare('INSERT INTO proxy_keys (id, name, key_hash, created_at, enabled, note) VALUES (?, ?, ?, ?, 1, ?)')
      .bind(p.id, p.name, p.keyHash, Date.now(), p.note ?? null)
      .run();
  }

  async setProxyKeyUsage(id: string): Promise<void> {
    await this.db.prepare('UPDATE proxy_keys SET last_used = ? WHERE id = ?').bind(Date.now(), id).run();
  }

  // ---------- stats / analytics ----------
  async poolStats(fromTs?: number): Promise<Record<string, unknown>> {
    const from = fromTs ?? Date.now() - 3600 * 1000;
    const [total, window, byAccount, byModel] = await Promise.all([
      this.db.prepare('SELECT COUNT(*) AS c FROM requests').first<{ c: number }>(),
      this.db.prepare('SELECT COUNT(*) AS c, SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) AS ok, AVG(response_time_ms) AS avg FROM requests WHERE timestamp >= ?').bind(from).first(),
      this.db.prepare('SELECT account_id, COUNT(*) AS c, SUM(success) AS ok FROM requests WHERE timestamp >= ? GROUP BY account_id').bind(from).all(),
      this.db.prepare('SELECT requested_model, COUNT(*) AS c FROM requests WHERE timestamp >= ? GROUP BY requested_model ORDER BY c DESC LIMIT 20').bind(from).all(),
    ]);
    return {
      total: total?.c ?? 0,
      window: { from, requests: Number(window?.c ?? 0), ok: Number(window?.ok ?? 0), avgMs: Math.round(Number(window?.avg ?? 0)) },
      byAccount: byAccount.results ?? [],
      byModel: byModel.results ?? [],
    };
  }

  async recentRequests(limit = 50): Promise<Array<Record<string, unknown>>> {
    const res = await this.db.prepare('SELECT * FROM requests ORDER BY timestamp DESC LIMIT ?').bind(limit).all();
    return res.results ?? [];
  }

  async clearRequests(): Promise<void> {
    await this.db.prepare('DELETE FROM requests').run();
  }
}

export type { D1Result };