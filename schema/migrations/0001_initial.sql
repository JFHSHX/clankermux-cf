-- Migration 0001: ClankerMux 初始 schema
-- 面向 key 池 (API-key provider) 场景的简化版, 保留原版核心账户/用量模型

-- 账户 (池中的一个上游 key / 账号)
CREATE TABLE IF NOT EXISTS accounts (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,              -- 显示名
  provider    TEXT NOT NULL DEFAULT 'openai',  -- openai | anthropic | openrouter | custom
  base_url    TEXT,                       -- 自定义上游 endpoint (custom provider)
  api_key     TEXT,                       -- 上游 API key (加密存储见 encrypt_key)
  enc_key     TEXT,                       -- 若设置了主动加密, 存放密文; 否则为空
  created_at  INTEGER NOT NULL,
  last_used   INTEGER,
  request_count INTEGER DEFAULT 0,        -- 当前会话窗口请求数
  total_requests INTEGER DEFAULT 0,      -- 累积请求数
  priority    INTEGER DEFAULT 0,          -- 越小越优先 (与上游加权)
  weight      REAL DEFAULT 1.0,           -- 自定义负载权重 (自定义加权策略用)
  paused      INTEGER DEFAULT 0,          -- 手动暂停
  pause_reason TEXT,                      -- manual | overage | rate_limit | failure
  rate_limited_until INTEGER,             -- 429 熔断生效截止 (DO 写入)
  rate_limited_reason TEXT,               -- upstream_429 | upstream_529 | exhaustion
  rate_limited_at INTEGER,
  consecutive_rate_limits INTEGER DEFAULT 0,
  session_start INTEGER,                  -- Session 策略粘性锚点
  session_request_count INTEGER DEFAULT 0,
  auto_fallback INTEGER DEFAULT 1,        -- 失败自动故障转移
  max_concurrent INTEGER DEFAULT 0,       -- 0 = 无限制; >0 限制并发 (单飞并发门)
  model_mappings TEXT,                    -- JSON: 请求模型名 -> 上游实际模型
  custom_headers TEXT,                    -- JSON: 附加请求头
  notes TEXT,
  disabled INTEGER DEFAULT 0              -- 软删除
);

-- 请求记录 (用量 / 历史 / 轮换审计)
CREATE TABLE IF NOT EXISTS requests (
  id          TEXT PRIMARY KEY,
  timestamp   INTEGER NOT NULL,
  method      TEXT NOT NULL,
  path        TEXT NOT NULL,
  account_id  TEXT,                       -- 被选中的账户
  provider    TEXT,
  requested_model TEXT,
  actual_model TEXT,
  status_code INTEGER,
  success     INTEGER,
  error_message TEXT,
  response_time_ms INTEGER,
  failover_attempts INTEGER DEFAULT 0,
  prompt_tokens INTEGER DEFAULT 0,
  completion_tokens INTEGER DEFAULT 0,
  cache_read_tokens INTEGER DEFAULT 0,
  cache_creation_tokens INTEGER DEFAULT 0,
  total_tokens INTEGER DEFAULT 0,
  api_key_id  TEXT,                       -- 调用方用的下游 proxy key (可用作隔离)
  strategy    TEXT,                       -- 命中的轮换策略
  decision    TEXT,                       -- least_used | round_robin | weighted | session | forced | failover
  affinity_key TEXT
);

-- 调用方 proxy 密钥 (发给下游客户端, 替代裸上游 key)
CREATE TABLE IF NOT EXISTS proxy_keys (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  key_hash     TEXT NOT NULL UNIQUE,      -- sha256(prefix + key) 
  created_at   INTEGER NOT NULL,
  last_used    INTEGER,
  enabled      INTEGER DEFAULT 1,
  note         TEXT
);

-- 全局设置 (前端可调的 key 池轮换策略等)
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 用量窗口快照 (FEFO 利用率来源 — 请求后按 token 更新)
CREATE TABLE IF NOT EXISTS usage (
  account_id    TEXT PRIMARY KEY,
  window_5h_start INTEGER,               -- 5h 用量窗口开始
  update_5h_tokens INTEGER DEFAULT 0,    -- 5h 内累积 token
  window_weekly_start INTEGER,           -- 7d 用量窗口开始
  update_weekly_tokens INTEGER DEFAULT 0, -- 7d 内累积 token
  last_updated INTEGER
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_requests_account ON requests(account_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_requests_ts ON requests(timestamp);
CREATE INDEX IF NOT EXISTS idx_requests_model ON requests(requested_model);
CREATE INDEX IF NOT EXISTS idx_accounts_paused ON accounts(disabled);