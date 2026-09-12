import { useEffect, useState, useCallback, useMemo } from 'react';
import { api } from './lib/api';

// ---------- 简易 hook ----------
function useToasts() {
  const [toasts, setToasts] = useState<string[]>([]);
  const toast = useCallback((m: string) => {
    setToasts((t) => [...t, m]);
    setTimeout(() => setToasts((t) => t.slice(1)), 2500);
  }, []);
  return { toasts, toast };
}

type Tab = 'overview' | 'accounts' | 'strategy' | 'usage' | 'models';

export default function App() {
  const [tab, setTab] = useState<Tab>('overview');
  const { toasts, toast } = useToasts();

  const go = (t: Tab) => { setTab(t); window.scrollTo(0, 0); };

  return (
    <div>
      <header>
        <h1>⚡ ClankerMux</h1>
        <nav>
          <button className={tab === 'overview' ? 'active' : ''} onClick={() => go('overview')}>总览</button>
          <button className={tab === 'accounts' ? 'active' : ''} onClick={() => go('accounts')}>Key 池</button>
          <button className={tab === 'strategy' ? 'active' : ''} onClick={() => go('strategy')}>轮换策略</button>
          <button className={tab === 'usage' ? 'active' : ''} onClick={() => go('usage')}>用量 & 日志</button>
          <button className={tab === 'models' ? 'active' : ''} onClick={() => go('models')}>可用模型</button>
        </nav>
      </header>
      <main>
        {tab === 'overview' && <Overview go={go} toast={toast} />}
        {tab === 'accounts' && <Accounts toast={toast} />}
        {tab === 'strategy' && <Strategy toast={toast} />}
        {tab === 'usage' && <Usage />}
        {tab === 'models' && <Models toast={toast} />}
      </main>
      {toasts.map((t, i) => <div key={i} className="toast">{t}</div>)}
    </div>
  );
}

// ---------- 总览 ----------
function Overview({ go, toast }: { go: (t: Tab) => void; toast: (m: string) => void }) {
  const [stats, setStats] = useState<any>(null);
  const [accounts, setAccounts] = useState<any[]>([]);
  const [settings, setSettings] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    const [s, a, st] = await Promise.all([api.stats(1), api.accounts(), api.settings()]);
    setStats(s); setAccounts(a); setSettings(st);
  }, []);

  useEffect(() => { load().catch(() => {}); }, [load]);

  if (!stats) return <div className="card muted">加载中…</div>;

  const utilTotal = stats.utilization?.reduce((x: any, u: any) => x + u.utilization, 0) || 0;
  const utilAvg = stats.utilization?.length ? Math.round(utilTotal / stats.utilization.length) : 0;

  const origin = window.location.origin;
  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); toast('已复制'); }
    catch { toast('复制失败, 请手动选择'); }
  };
  const endpoints = [
    { label: 'OpenAI 兼容', url: `${origin}/wire/openai/v1` },
    { label: 'Anthropic 兼容', url: `${origin}/wire/anthropic/v1` },
  ];

  return (
    <div className="grid">
      <div className="card" style={{ gridColumn: '1 / -1' }}>
        <h2>接入端点</h2>
        <div className="hint" style={{ marginBottom: '.6rem' }}>把客户端的 base_url 指向下面地址; API key 填任意非空字符串, 代理会自动注入池内真 key 并轮换.</div>
        {endpoints.map((e) => (
          <div key={e.label} className="row" style={{ marginBottom: '.4rem' }}>
            <span className="badge neutral" style={{ minWidth: '6.5em', textAlign: 'center' }}>{e.label}</span>
            <code style={{ flex: 1 }}>{e.url}</code>
            <button className="btn" style={{ padding: '.2rem .6rem' }} onClick={() => copy(e.url)}>复制</button>
          </div>
        ))}
      </div>

      <div className="card">
        <h2>池状态</h2>
        <div className="metric">
          <div className="m"><div className="v">{accounts.filter((a: any) => !a.paused && !a.disabled && !a.circuit?.until).length}<span style={{fontSize:'.9rem'}}>/{accounts.length}</span></div><div className="l">可用 / 总数</div></div>
          <div className="m"><div className="v">{stats.window?.requests ?? 0}</div><div className="l">近 1h 请求</div></div>
          <div className="m"><div className="v">{stats.window?.ok ?? 0}</div><div className="l">成功</div></div>
          <div className="m"><div className="v">{stats.window?.avgMs ?? 0}ms</div><div className="l">平均延迟</div></div>
          <div className="m"><div className="v" style={{color: utilAvg > 80 ? 'var(--red)' : utilAvg > 55 ? 'var(--amber)' : 'var(--text)'}}>{utilAvg}%</div><div className="l">池平均利用率</div></div>
        </div>
      </div>

      <div className="card">
        <h2>熔断账户 (429/529)</h2>
        {accounts.filter((a: any) => a.circuit?.until).length === 0
          ? <div className="muted">暂无熔断. ✅</div>
          : <table>
              <thead><tr><th>账户</th><th>原因</th><th>剩余 (s)</th></tr></thead>
              <tbody>
                {accounts.filter((a: any) => a.circuit?.until).map((a: any) =>
                  <tr key={a.id}>
                    <td>{a.name}</td>
                    <td><span className="badge circuit">{a.circuit?.reason ?? a.pause_reason}</span></td>
                    <td>{a.circuit?.until ? Math.max(0, Math.round((a.circuit.until - Date.now()) / 1000)) : '-'}</td>
                  </tr>)}
              </tbody>
            </table>}
      </div>

      <div className="card">
        <h2>快捷操作</h2>
        <div className="row">
          <button className="btn primary" onClick={() => go('accounts')}>管理 Key 池</button>
          <button className="btn" onClick={() => go('strategy')}>调整轮换策略</button>
          <button className="btn success" onClick={() => go('usage')}>查看日志</button>
          <button className="btn danger" onClick={async () => { if (confirm('清空所有熔断状态并恢复账户?')) { await api.resetAll(); toast('已重置'); load(); } }}>重置全部熔断</button>
        </div>
        <div className="hint">当前策略: <code>{settings.strategy || 'fefo'}</code></div>
      </div>
    </div>
  );
}

// ---------- Key 池 ----------
function Accounts({ toast }: { toast: (m: string) => void }) {
  const [accounts, setAccounts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<any>(null); // 正在编辑的账户 (null=新建弹窗关闭)

  const load = useCallback(async () => {
    setLoading(true);
    try { setAccounts(await api.accounts()); } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const update = async (id: string, patch: any, msg: string) => {
    await api.updateAccount(id, patch);
    toast(msg); load();
  };

  // 新建/编辑弹窗
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<any>(null);

  const openNew = () => { setForm({ name: '', provider: 'custom', base_url: '', api_key: '', priority: 0, weight: 1, max_concurrent: 0, auto_fallback: true }); setShowForm(true); };
  const openEdit = (a: any) => { setForm({ id: a.id, name: a.name, provider: a.provider, base_url: a.base_url || '', priority: a.priority, weight: a.weight, max_concurrent: a.max_concurrent || 0, auto_fallback: a.auto_fallback !== 0 }); setShowForm(true); };

  const submitForm = async () => {
    if (!form?.name) return toast('名称必填');
    try {
      if (form.id) { await api.updateAccount(form.id, form); }
      else { await api.createAccount(form); }
      toast(form.id ? '已更新' : '已添加');
      setShowForm(false); load();
    } catch (e: any) { toast(e.message); }
  };

  return (
    <div className="grid">
      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0 }}>Key 池 (上游账户)</h2>
          <button className="btn primary" onClick={openNew}>+ 添加账户</button>
        </div>
        <div className="hint">每个账户代表一个上游 API key. 轮换策略会在可用账户中挑选. 优先级越小越靠前.</div>
        {loading ? <div className="muted">加载中…</div> : accounts.length === 0
          ? <div className="muted" style={{ padding: '1rem 0' }}>暂无账户. 点击"添加账户"开始.</div>
          : <table>
              <thead>
                <tr><th>名称</th><th>Provider</th><th>优先级</th><th>权重</th><th>状态</th><th>利用率</th><th>请求</th><th>操作</th></tr>
              </thead>
              <tbody>
                {accounts.map((a: any) => {
                  const circuit = a.circuit?.until && a.circuit.until > Date.now();
                  const state = a.disabled ? 'disabled' : a.paused ? 'paused' : circuit ? 'circuit' : 'ok';
                  return (
                    <tr key={a.id}>
                      <td>{a.name}</td>
                      <td><span className="badge neutral">{a.provider}</span></td>
                      <td>{a.priority}</td>
                      <td>{a.weight}</td>
                      <td>
                        {state === 'ok' && <span className="badge ok">可用</span>}
                        {state === 'paused' && <span className="badge paused">已暂停</span>}
                        {state === 'circuit' && <span className="badge circuit">熔断{(a.circuit?.reason || '')}</span>}
                        {state === 'disabled' && <span className="badge neutral">禁用</span>}
                      </td>
                      <td>{a.utilization !== undefined ? Math.round(a.utilization) : '-'}%</td>
                      <td>{a.total_requests}</td>
                      <td>
                        <div className="row">
                          <button className="btn" style={{ padding: '.25rem .5rem' }} onClick={() => openEdit(a)}>编辑</button>
                          {state === 'paused' || state === 'circuit'
                            ? <button className="btn success" style={{ padding: '.25rem .5rem' }} onClick={() => update(a.id, { pause: false }, `${a.name} 已恢复`)}>恢复</button>
                            : <button className="btn" style={{ padding: '.25rem .5rem' }} onClick={() => update(a.id, { pause: true }, `${a.name} 已暂停`)}>暂停</button>}
                          {a.disabled
                            ? <button className="btn" style={{ padding: '.25rem .5rem' }} onClick={() => update(a.id, { disabled: false }, '已启用')}>启用</button>
                            : <button className="btn" style={{ padding: '.25rem .5rem' }} onClick={() => update(a.id, { disabled: true }, '已禁用')}>禁用</button>}
                          <button className="btn danger" style={{ padding: '.25rem .5rem' }} onClick={async () => { if (confirm(`删除 ${a.name}?`)) { await api.deleteAccount(a.id); toast('已删除'); load(); } }}>删除</button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>}
      </div>

      {showForm && form && <AccountForm form={form} setForm={setForm} onClose={() => setShowForm(false)} onSubmit={submitForm} />}
    </div>
  );
}

function AccountForm({ form, setForm, onClose, onSubmit }: any) {
  const F = (k: string) => ({ value: form[k] ?? '', onChange: (e: any) => setForm({ ...form, [k]: e.target.value }) });
  return (
    <div className="card" style={{ borderColor: 'var(--accent)' }}>
      <h2>{form.id ? '编辑账户' : '添加账户'}</h2>
      <div className="row">
        <input placeholder="名称 (必填)" {...F('name')} style={{ flex: 1 }} />
        <select {...F('provider')}>
          <option value="custom">OpenAI 兼容</option>
          <option value="openai">OpenAI</option>
          <option value="anthropic">Anthropic</option>
          <option value="openrouter">OpenRouter</option>
        </select>
      </div>
      {form.provider === 'custom' && <div style={{ marginTop: '.5rem' }}><input placeholder="Base URL (如 https://integrate.api.nvidia.com/v1)" {...F('base_url')} style={{ width: '100%' }} /></div>}
      <div style={{ marginTop: '.5rem' }}><input placeholder="上游 API key (仅新建时填写)" {...F('api_key')} style={{ width: '100%' }} type="password" /></div>
      <div className="row" style={{ marginTop: '.5rem' }}>
        <label>优先级 <input type="number" {...F('priority')} style={{ width: '70px' }} /></label>
        <label>权重 <input type="number" step="0.1" {...F('weight')} style={{ width: '70px' }} /></label>
        <label>最大并发 (0=不限) <input type="number" {...F('max_concurrent')} style={{ width: '80px' }} /></label>
        <label title="失败时自动故障转移到其它账户"><input type="checkbox" checked={!!form.auto_fallback} onChange={(e) => setForm({ ...form, auto_fallback: e.target.checked })} /> 自动故障转移</label>
      </div>
      <div className="row" style={{ marginTop: '.8rem' }}>
        <button className="btn primary" onClick={onSubmit}>{form.id ? '保存' : '添加'}</button>
        <button className="btn" onClick={onClose}>取消</button>
      </div>
      <div className="hint">优先级: 越小越优先. 权重: 加权轮询策略下越大命中率越高.</div>
    </div>
  );
}

// ---------- 轮换策略 ----------
const STRATEGY_OPTIONS = [
  { value: 'fefo', label: 'FEFO (First-Expiring First-Out) — 容量感知', desc: '按剩余配额排序, 优先使用最早恢复容量/最空闲的账户, 突发并发自动轮换.' },
  { value: 'roundrobin', label: '轮询 (Round-robin)', desc: '均匀分摊到所有可用账户, 无粘性, 突发友好.' },
  { value: 'weighted', label: '加权轮询 (Weighted)', desc: '按账户权重分配, 权重大的命中率高. 适合负载不均的池.' },
  { value: 'session', label: '会话粘性 (Session, 5h)', desc: '同一客户端/项目固定在初始账户上, 最大化 prompt cache 命中. 熔断时自动转移.' },
];

function Strategy({ toast }: { toast: (m: string) => void }) {
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState<any>(null);

  const load = useCallback(async () => { setSettings(await api.settings()); }, []);
  useEffect(() => { load(); }, [load]);

  const set = (k: string) => ({
    value: settings[k] ?? '',
    onChange: (e: any) => setSettings((s) => ({ ...s, [k]: e.target.value })),
  });

  const save = async () => {
    setSaving(true);
    try {
      await api.saveSettings(settings);
      toast('策略设置已保存 (即时生效)');
    } catch (e: any) { toast(e.message); } finally { setSaving(false); }
  };

  const runPreview = async () => {
    try { setPreview(await api.preview(settings)); }
    catch (e: any) { toast(e.message); }
  };

  const selected = STRATEGY_OPTIONS.find((o) => o.value === (settings.strategy || 'fefo'));

  return (
    <div className="grid">
      <div className="card">
        <h2>负载均衡策略</h2>
        <div className="hint">这是用于 proxy key 的分发核心策略. 修改后即时生效.</div>
        <div style={{ marginTop: '.8rem' }}>
          {STRATEGY_OPTIONS.map((o) => (
            <label key={o.value} style={{ display: 'flex', gap: '.6rem', padding: '.6rem 0', alignItems: 'flex-start', cursor: 'pointer' }}>
              <input type="radio" style={{ marginTop: '.2rem' }} checked={(settings.strategy || 'fefo') === o.value} onChange={() => setSettings((s) => ({ ...s, strategy: o.value }))} />
              <div>
                <b>{o.label}</b>
                <div className="muted">{o.desc}</div>
              </div>
            </label>
          ))}
        </div>
      </div>

      {selected?.value === 'fefo' && (
        <div className="card">
          <h2>FEFO 参数</h2>
          <div className="row">
            <label>5h 窗口 token 预算 <input type="number" {...set('fefo_budget_5h')} style={{ width: '130px' }} /></label>
            <label>7d 窗口 token 预算 <input type="number" {...set('fefo_budget_weekly')} style={{ width: '130px' }} /></label>
          </div>
          <div className="hint">FEFO 依据账户在 5h 窗口的已用 token / 预算计算利用率, 选择最空闲且最早恢复容量的账户.</div>
        </div>
      )}
      {selected?.value === 'session' && (
        <div className="card">
          <h2>会话参数</h2>
          <div className="row">
            <label>会话时长 (小时) <input type="number" {...set('session_duration_hours')} style={{ width: '80px' }} /></label>
          </div>
          <div className="hint">同一 affinity key (proxy key / 客户端) 的请求在会话窗口内固定到同一账户以复用 prompt cache.</div>
        </div>
      )}

      <div className="card">
        <h2>熔断 & 恢复参数</h2>
        <div className="row">
          <label>429 熔断 cooldown (秒) <input type="number" {...set('cooldown_429_seconds')} style={{ width: '80px' }} /></label>
          <label>529 熔断 cooldown (秒) <input type="number" {...set('cooldown_529_seconds')} style={{ width: '80px' }} /></label>
          <label>探测失败退避 (秒) <input type="number" {...set('probe_backoff_seconds')} style={{ width: '80px' }} /></label>
          <label>最大故障转移次数 <input type="number" {...set('max_failover')} style={{ width: '80px' }} /></label>
        </div>
        <div className="hint">429/529 会触发账户熔断, 该账户在 cooldown 内不再被选中; 到期后由单飞探测验证是否恢复. 探测失败按退避延后.</div>
      </div>

      <div className="card">
        <h2>上游默认端点</h2>
        <div className="row">
          <label style={{ flex: 1 }}>OpenAI 兼容默认 Base URL <input {...set('openai_upstream')} style={{ width: '100%' }} /></label>
        </div>
        <div className="row" style={{ marginTop: '.5rem' }}>
          <label style={{ flex: 1 }}>Anthropic 默认 Base URL <input {...set('anthropic_upstream')} style={{ width: '100%' }} /></label>
        </div>
        <div className="hint">账户未单独指定 base_url 时使用此处默认值. 也可通过环境变量 UPSTREAM_OPENAI / UPSTREAM_ANTHROPIC 覆盖.</div>
      </div>

      <div className="card" style={{ borderColor: 'var(--accent2)' }}>
        <h2>测试轮换</h2>
        <div className="row">
          <button className="btn primary" onClick={save} disabled={saving}>{saving ? '保存中…' : '保存设置'}</button>
          <button className="btn" onClick={runPreview}>模拟一次选择</button>
        </div>
        {preview && (
          <div style={{ marginTop: '.8rem' }}>
            <div className="row"><span className="muted">本次选中:</span> <b>{preview.selected?.name || '(无可用账户)'}</b></div>
            <div className="hint">候选排序 (<code>{preview.strategy}</code>):</div>
            <table style={{ marginTop: '.4rem' }}>
              <thead><tr><th>#</th><th>名称</th><th>优先级</th><th>利用率</th></tr></thead>
              <tbody>
                {(preview.ranked || []).map((r: any, i: number) => (
                  <tr key={r.id}><td>{i + 1}</td><td>{r.name}</td><td>{r.priority}</td><td>{r.utilization}%</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- 用量 & 日志 ----------
function Usage() {
  const [stats, setStats] = useState<any>(null);
  const [requests, setRequests] = useState<any[]>([]);
  const [hours, setHours] = useState(1);

  const load = useCallback(async (h: number) => {
    const [s, r] = await Promise.all([api.stats(h), api.requests(100)]);
    setStats(s); setRequests(r.requests || []);
  }, []);
  useEffect(() => { load(hours); }, [load, hours]);

  if (!stats) return <div className="card muted">加载中…</div>;

  return (
    <div className="grid">
      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0 }}>池用量</h2>
          <div className="row">
            <span className="muted">时间窗:</span>
            {[1, 6, 24].map((h) => <button key={h} className={`btn ${hours === h ? 'primary' : ''}`} style={{ padding: '.25rem .6rem' }} onClick={() => setHours(h)}>{h}h</button>)}
          </div>
        </div>
        <div className="metric" style={{ marginTop: '.8rem' }}>
          <div className="m"><div className="v">{stats.window?.requests ?? 0}</div><div className="l">请求数</div></div>
          <div className="m"><div className="v">{stats.window?.ok ?? 0}</div><div className="l">成功</div></div>
          <div className="m"><div className="v">{stats.total ?? 0}</div><div className="l">累计请求</div></div>
        </div>
        {stats.utilization?.length > 0 && (
          <div style={{ marginTop: '1rem' }}>
            <h3 style={{ fontSize: '.9rem', margin: '0 0 .6rem' }}>各账户 5h 利用率</h3>
            {stats.utilization.map((u: any) => (
              <div key={u.id} style={{ marginBottom: '.5rem' }}>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <span style={{ fontSize: '.85rem' }}>{u.name}</span>
                  <span className="muted">{u.utilization}%</span>
                </div>
                <div className={`bar ${u.utilization > 80 ? 'critical' : u.utilization > 55 ? 'warn' : ''}`}>
                  <div style={{ width: `${Math.min(100, u.utilization)}%` }} />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="card">
        <h2>请求日志</h2>
        <table style={{ fontSize: '.8rem' }}>
          <thead><tr><th>时间</th><th>账户</th><th>状态</th><th>模型</th><th>Tokens</th><th>延迟</th><th>决策</th></tr></thead>
          <tbody>
            {requests.length === 0 && <tr><td colSpan={7} className="muted">暂无请求. 通过代理发起请求后这里会显示.</td></tr>}
            {requests.map((r: any) => (
              <tr key={r.id}>
                <td title={new Date(r.timestamp).toISOString()}>{new Date(r.timestamp).toLocaleTimeString('zh-CN')}</td>
                <td>{r.account_id || '-'}</td>
                <td><span className={`badge ${r.success ? 'ok' : 'circuit'}`}>{r.status_code}</span></td>
                <td>{r.requested_model || '-'}</td>
                <td>{r.total_tokens}</td>
                <td>{r.response_time_ms}ms</td>
                <td><span className="badge neutral">{r.decision}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------- 可用模型 ----------
function Models({ toast }: { toast: (m: string) => void }) {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState('');

  const load = useCallback(async (refresh = false) => {
    refresh ? setRefreshing(true) : setLoading(true);
    try {
      setData(await api.models(refresh));
      if (refresh) toast('已从各上游刷新');
    } catch (e: any) { toast(`获取模型失败: ${e.message}`); }
    finally { setLoading(false); setRefreshing(false); }
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <div className="muted">加载中…</div>;
  if (!data) return <div className="muted">暂无数据.</div>;

  const q = filter.trim().toLowerCase();
  const models = q ? data.models.filter((m: any) => m.id.toLowerCase().includes(q)) : data.models;

  return (
    <div className="grid">
      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0 }}>可用模型 ({data.models.length})</h2>
          <div className="row">
            <input placeholder="过滤模型名…" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: 180 }} />
            <button className="btn" onClick={() => load(true)} disabled={refreshing}>{refreshing ? '刷新中…' : '↻ 向上游刷新'}</button>
          </div>
        </div>
        <div className="hint">
          聚合自各账户上游 /models · 缓存于 {new Date(data.fetched_at).toLocaleTimeString('zh-CN')} · 10 分钟自动过期 ·
          {data.per_account.filter((p: any) => !p.ok).length > 0 && (
            <> 拉取失败: {data.per_account.filter((p: any) => !p.ok).map((p: any) => `${p.account}(${p.error})`).join(', ')}</>
          )}
        </div>
        <table style={{ marginTop: '.8rem' }}>
          <thead><tr><th>模型 ID</th><th>支持的 Key</th><th>数量</th></tr></thead>
          <tbody>
            {models.length === 0 && <tr><td colSpan={3} className="muted">无匹配模型</td></tr>}
            {models.map((m: any) => (
              <tr key={m.id}>
                <td><code>{m.id}</code></td>
                <td>{m.accounts.map((a: string) => <span key={a} className="badge ok" style={{ marginRight: '.3rem' }}>{a}</span>)}</td>
                <td>{m.accounts.length}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h2>各账户模型数</h2>
        <div className="metric">
          {data.per_account.map((p: any) => (
            <div key={p.account} className="m">
              <div className="v">{p.ok ? p.count : '✗'}</div>
              <div className="l">{p.account}{p.ok ? '' : ` · ${p.error}`}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}