(() => {
  'use strict';
  const caseId = document.body.dataset.case;
  const chat = document.getElementById('chat');
  const form = document.getElementById('chatForm');
  const input = document.getElementById('userInput');
  const target = document.getElementById('target');
  const send = document.getElementById('send');
  const reset = document.getElementById('reset');
  const status = document.getElementById('status');
  // No localStorage, shared server history, or student identifiers.
  let history = [];
  let pending = null;
  let generation = 0;
  let blockedUntil = 0;
  let cooldownTimer;
  const MAX_TURNS = 60;

  function render(text, sender) {
    const node = document.createElement('div');
    node.className = `message ${sender}`;
    node.textContent = text;
    chat.appendChild(node);
    chat.scrollTop = chat.scrollHeight;
  }
  function announce(text, error = false) {
    status.textContent = text;
    status.className = error ? 'error' : '';
  }
  function updateControls() {
    const waiting = Date.now() < blockedUntil;
    send.disabled = !!pending || waiting || history.length >= MAX_TURNS * 2;
    input.disabled = !!pending;
    if (target) target.disabled = !!pending;
    send.textContent = pending ? '回答を待っています…' : '送信';
  }
  function cooldown(seconds) {
    blockedUntil = Date.now() + seconds * 1000;
    clearInterval(cooldownTimer);
    const tick = () => {
      const left = Math.ceil((blockedUntil - Date.now()) / 1000);
      if (left > 0) announce(`利用が集中しています。あと${left}秒待ってから送信してください。質問は入力欄に残っています。`, true);
      else { clearInterval(cooldownTimer); announce('送信できます。'); }
      updateControls();
    };
    tick();
    cooldownTimer = setInterval(tick, 1000);
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (pending || Date.now() < blockedUntil || history.length >= MAX_TURNS * 2) return;
    const text = input.value.trim();
    if (!text) { announce('質問を入力してください。'); input.focus(); return; }
    if (text.length > 2000) { announce('質問は2,000文字以内で入力してください。', true); return; }
    const selected = target?.value || 'auto';
    const names = { kazuko: '和子さんへ', kenta: '健太さんへ', both: 'お二人へ' };
    const currentGeneration = generation;
    const controller = new AbortController();
    pending = controller;
    updateControls();
    announce('回答を待っています…');
    const timeout = setTimeout(() => controller.abort(), 55000);
    try {
      const response = await fetch('/api/community-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caseId, history, message: text, target: selected }),
        signal: controller.signal
      });
      const data = await response.json().catch(() => ({}));
      if (currentGeneration !== generation) return;
      if (response.status === 429) {
        cooldown(Math.min(3600, Math.max(1, Number(data.retryAfter) || 30)));
        return;
      }
      if (!response.ok) throw new Error(data.error || '通信に失敗しました。しばらく待ってから再度送信してください。');
      if (typeof data.reply !== 'string' || !data.reply.trim() || typeof data.userMessage !== 'string') {
        throw new Error('回答を受け取れませんでした。もう一度送信してください。');
      }
      history.push({ role: 'user', content: data.userMessage }, { role: 'assistant', content: data.reply });
      render(names[selected] ? `${names[selected]}\n${text}` : text, 'user');
      render(data.reply, 'gpt');
      input.value = '';
      announce(history.length >= MAX_TURNS * 2 ? '60回の対話が終了しました。履歴を確認し、続ける場合は最初からやり直してください。' : '');
    } catch (error) {
      if (currentGeneration !== generation) return;
      announce(error.name === 'AbortError'
        ? '応答に時間がかかっています。質問は残っています。少し待って再度送信してください。'
        : (error instanceof TypeError ? '接続できませんでした。通信環境を確認して再度送信してください。' : error.message), true);
    } finally {
      clearTimeout(timeout);
      if (currentGeneration === generation) { pending = null; updateControls(); input.focus(); }
    }
  });
  input.addEventListener('keydown', event => {
    // Enter is a newline: Japanese IME confirmation must never send a message.
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing && event.keyCode !== 229) {
      event.preventDefault(); form.requestSubmit();
    }
  });
  reset.addEventListener('click', () => {
    if (!window.confirm('この画面の会話を消して、最初からやり直しますか？')) return;
    generation++;
    pending?.abort();
    pending = null;
    history = [];
    chat.replaceChildren();
    input.value = '';
    if (target) target.value = 'auto';
    // Keep a rate-limit cooldown even when the conversation is reset.
    if (Date.now() >= blockedUntil) announce('新しい面談です。質問を入力してください。');
    updateControls(); input.focus();
  });
  updateControls();
})();
