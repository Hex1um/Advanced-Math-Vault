/* 免费公共通道：由浏览器直连，用访客自己的 IP 额度 */
(function () {
  'use strict';

  const ENDPOINT = 'https://text.pollinations.ai/openai';
  const MODELS = ['openai-fast', 'openai'];
  const GUARD = /^(The API key used|Too Many Requests|Rate limit|Free limit)/i;

  function httpError(status) {
    const e = new Error(status === 402
      ? '免费通道冷却中：同一网络 45 秒只能问一次'
      : '免费通道返回 ' + status);
    e.code = status === 402 ? 'FREE_LIMIT' : 'FREE_HTTP';
    e.status = status;
    return e;
  }

  async function stream(messages, onDelta) {
    for (const model of MODELS) {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages, stream: true, temperature: 0.6 })
      });
      if (!res.ok) {
        if (res.status === 402) throw httpError(402);
        continue;
      }
      if (!res.body) continue;

      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      let text = '';
      let pre = '';
      let flushed = false;

      const push = (c) => {
        if (!c) return;
        if (!flushed) {
          pre += c;
          if (pre.length < 24) return;
          if (GUARD.test(pre.trim())) throw new Error('免费通道返回异常内容');
          flushed = true;
          text += pre;
          onDelta(pre);
          return;
        }
        text += c;
        onDelta(c);
      };

      while (true) {
        const r = await reader.read();
        if (r.done) break;
        buf += dec.decode(r.value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') {
            if (!flushed && pre) { text += pre; onDelta(pre); }
            return text;
          }
          try {
            const j = JSON.parse(data);
            push(j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content);
          } catch (e) {
            if (String(e.message).indexOf('异常内容') >= 0) throw e;
          }
        }
      }
      if (!flushed && pre) { text += pre; onDelta(pre); }
      if (text.trim()) return text;
    }
    throw new Error('免费通道没有返回内容');
  }

  async function complete(messages) {
    for (const model of MODELS) {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages, stream: false, temperature: 0.7 })
      });
      if (!res.ok) {
        if (res.status === 402) throw httpError(402);
        continue;
      }
      const j = await res.json();
      const text = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
      if (text.trim() && !GUARD.test(text.trim())) return text;
    }
    throw new Error('免费通道没有返回内容');
  }

  window.FreeLLM = { stream, complete, available: true };
})();
