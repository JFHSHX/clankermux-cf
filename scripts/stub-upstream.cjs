// 本地模拟上游 (仅测试用) — 模拟 OpenAI-compatible /chat/completions
// 环境变量控制行为:
//   PORT       端口 (默认 9100)
//   MODE       normal | always429 | always500 | flaky
const http = require('http');

const PORT = process.env.PORT || 9100;
const MODE = process.env.MODE || 'normal';
let count = 0;

http.createServer((req, res) => {
  count++;
  const url = req.url || '';
  res.setHeader('content-type', 'application/json');
  res.setHeader('access-control-allow-origin', '*');

  // /chat/completions
  if (url.includes('/chat/completions')) {
    // HANG_MS: 延迟 N 毫秒才响应, 模拟上游卡死 (测首字节超时换 key)
    const hangMs = process.env.HANG_MS ? Number(process.env.HANG_MS) : 0;
    if (hangMs > 0) {
      setTimeout(() => {
        res.statusCode = 504;
        res.end(JSON.stringify({ error: { message: 'stub hung (test)' } }));
      }, hangMs);
      return;
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let model = 'unknown';
      try { model = JSON.parse(body).model || 'unknown'; } catch {}
      const key = req.headers.authorization || 'none';

      if (MODE === 'always429' || (MODE === 'flaky' && count % 2 === 0)) {
        res.statusCode = 429;
        res.setHeader('retry-after', '2');
        res.end(JSON.stringify({ error: { message: 'rate limited', type: 'rate_limit_error' }, model }));
        return;
      }
      if (MODE === 'always500') {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: { message: 'server error', type: 'server_error' }, model }));
        return;
      }
      // 63 个字节约等于 ~16 tokens, 用包含文本的 JSON body 不 stream
      res.end(JSON.stringify({
        id: 'chatcmpl-' + count,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, message: { role: 'assistant', content: 'hi from stub ' + key }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        x_account: key.split(' ')[1] || 'none',
      }));
    });
    return;
  }

  // /models — CONTEXT_LEN 环境变量(数字)存在时给每个条目附加 context_length, 模拟含该字段的上游
  if (url.includes('/models')) {
    const cl = process.env.CONTEXT_LEN ? Number(process.env.CONTEXT_LEN) : null;
    const mk = (id) => (cl ? { id, object: 'model', context_length: cl } : { id, object: 'model' });
    res.end(JSON.stringify({
      object: 'list',
      data: [
        mk('gpt-4o'),
        mk('gpt-4o-mini'),
        mk('deepseek-ai/deepseek-v4-flash-0731'),
        mk('custom/builtin-only'),
      ],
    }));
    return;
  }

  res.statusCode = 404;
  res.end(JSON.stringify({ error: 'not found' }));
}).listen(PORT, () => {
  console.log(`stub upstream on :${PORT} mode=${MODE}`);
});