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
  const copy = document.getElementById('copyLog');
  const copyStatus = document.getElementById('copyStatus');
  const manualCopy = document.getElementById('manualCopy');
  const logText = document.getElementById('logText');
  const selectLog = document.getElementById('selectLog');
  const interviewProgress = document.getElementById('interviewProgress');
  const usageKey = `community_case${caseId}_totalUsage`;
  const MEETING_TARGET = 25;
  const MEETING_LIMIT = 28;
  const TOTAL_USAGE_LIMIT = 40;
  // Conversation history remains in memory; localStorage contains only the per-case cumulative request count.
  let history = [];
  // Selection metadata only; the conversation itself remains in history.
  let questionTargets = [];
  let copying = false;
  let pending = null;
  let generation = 0;
  let blockedUntil = 0;
  let cooldownTimer;
  let meetingUsage = 0;
  let usageStorageAvailable = true;

  function readTotalUsage() {
    try {
      const value = Number.parseInt(localStorage.getItem(usageKey) || '0', 10);
      return Number.isFinite(value) ? Math.min(TOTAL_USAGE_LIMIT, Math.max(0, value)) : 0;
    } catch {
      usageStorageAvailable = false;
      return TOTAL_USAGE_LIMIT;
    }
  }
  let totalUsage = readTotalUsage();

  function consumeUsage() {
    const current = readTotalUsage();
    totalUsage = current;
    if (!usageStorageAvailable || current >= TOTAL_USAGE_LIMIT) return false;
    try {
      totalUsage = current + 1;
      localStorage.setItem(usageKey, String(totalUsage));
      return true;
    } catch {
      usageStorageAvailable = false;
      totalUsage = TOTAL_USAGE_LIMIT;
      return false;
    }
  }

  function usageLimitMessage() {
    if (totalUsage >= TOTAL_USAGE_LIMIT) return 'この演習で利用できる上限に達しました．これまでの会話ログを提出してください．';
    if (meetingUsage >= MEETING_LIMIT) return '面談は終了しました．会話ログをコピーして提出してください．';
    return '';
  }

  function updateInterviewProgress() {
    const percent = Math.max(0, Math.round((MEETING_TARGET - meetingUsage) / MEETING_TARGET * 100));
    interviewProgress.value = percent;
    interviewProgress.textContent = `${percent}%`;
    interviewProgress.className = percent <= 20 ? 'low' : '';
  }

  function announceAfterReply() {
    const limit = usageLimitMessage();
    if (limit) return announce(limit);
    if (meetingUsage === MEETING_TARGET) return announce('予定していた面談時間になりました．必要な確認があれば，あと少しだけ質問できます．');
    if (meetingUsage > MEETING_TARGET) return announce('面談終了の時間が近づいています．');
    announce('');
  }

  function conversationText() {
    const titles = {
      A: '精神疾患のある息子と暮らす高齢女性の地域生活',
      B: '免許返納をきっかけに生活が変化した独居高齢男性の地域生活'
    };
    const names = { kazuko: '和子さん', kenta: '健太さん', both: 'お二人' };
    const entries = history.map((message, index) => {
      if (message.role === 'user') {
        const name = caseId === 'A' ? names[questionTargets[index / 2]] : undefined;
        const prefix = name ? `【質問先：${name}】\n` : '';
        const text = prefix && message.content.startsWith(prefix) ? message.content.slice(prefix.length) : message.content;
        return `看護師${name ? `（${name}へ）` : ''}：\n${text}`;
      }
      // The API returns one or more named utterances, including both speakers in A.
      // Keep the original text intact if it does not match that format.
      const pattern = caseId === 'A' ? /^(?:(?:和子|健太)「[^「」]*」\s*)+$/u : /^(?:正夫「[^「」]*」\s*)+$/u;
      if (!pattern.test(message.content.trim())) return `対象者：\n${message.content}`;
      return [...message.content.matchAll(/(和子|健太|正夫)「([^「」]*)」/gu)]
        .map(([, name, text]) => `${name}：\n${text}`).join('\n\n');
    });
    return `地域包括ケア演習 事例${caseId}\n${titles[caseId]}\n\n【会話ログ】\n${entries.join('\n\n')}`;
  }
  function refreshCopyLog() {
    copy.disabled = copying || history.length === 0;
    if (!history.length) {
      manualCopy.hidden = true;
      logText.value = '';
      copyStatus.textContent = 'まだ会話がありません。回答を受け取るとコピーできます。';
    } else {
      if (!manualCopy.hidden) logText.value = conversationText();
      copyStatus.textContent = '最新の会話全文をコピーできます。';
    }
  }
  copy.addEventListener('click', async () => {
    if (copying || !history.length) return;
    const currentGeneration = generation;
    const count = history.length;
    const text = conversationText();
    copying = true;
    copy.disabled = true;
    copyStatus.textContent = '会話ログをコピーしています…';
    try {
      // Invoke directly from the button gesture, including on mobile browsers.
      await navigator.clipboard.writeText(text);
      if (currentGeneration !== generation) return;
      manualCopy.hidden = true;
      logText.value = '';
      copyStatus.textContent = '会話ログをコピーしました．Moodleの提出欄に貼り付けてください．';
      if (history.length !== count) copyStatus.textContent += ' コピー後に回答が追加されました。最新の全文はもう一度コピーしてください。';
    } catch {
      if (currentGeneration !== generation) return;
      manualCopy.hidden = false;
      logText.value = conversationText();
      copyStatus.textContent = '自動コピーできませんでした。下の会話ログを全選択して、手動でコピーしてください。';
    } finally {
      if (currentGeneration === generation) { copying = false; copy.disabled = !history.length; }
    }
  });
  selectLog.addEventListener('click', () => {
    logText.focus();
    logText.select();
    logText.setSelectionRange(0, logText.value.length);
  });

  function render(text, sender) {
    const node = document.createElement('div');
    node.className = `message ${sender}`;
    node.textContent = text;
    chat.appendChild(node);
    chat.scrollTop = chat.scrollHeight;
    return node;
  }
  function announce(text, error = false) {
    status.textContent = text;
    status.className = error ? 'error' : '';
  }
  function updateControls() {
    const waiting = Date.now() < blockedUntil;
    const ended = meetingUsage >= MEETING_LIMIT || totalUsage >= TOTAL_USAGE_LIMIT;
    send.disabled = !!pending || waiting || ended;
    input.disabled = !!pending || ended;
    if (target) target.disabled = !!pending || ended;
    send.textContent = pending ? '回答を待っています…' : '送信';
  }
  function cooldown(seconds) {
    blockedUntil = Date.now() + seconds * 1000;
    clearInterval(cooldownTimer);
    const tick = () => {
      const left = Math.ceil((blockedUntil - Date.now()) / 1000);
      if (left > 0) announce(`利用が集中しています。あと${left}秒待ってから送信してください。質問は入力欄に残っています。`, true);
      else { clearInterval(cooldownTimer); announce(usageLimitMessage() || '送信できます。'); }
      updateControls();
    };
    tick();
    cooldownTimer = setInterval(tick, 1000);
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    totalUsage = readTotalUsage();
    if (pending || Date.now() < blockedUntil || meetingUsage >= MEETING_LIMIT || totalUsage >= TOTAL_USAGE_LIMIT) {
      const limit = usageLimitMessage();
      if (limit) announce(limit);
      updateControls();
      return;
    }
    const text = input.value.trim();
    if (!text) { announce('質問を入力してください。'); input.focus(); return; }
    if (text.length > 2000) { announce('質問は2,000文字以内で入力してください。', true); return; }
    const selected = target?.value || 'auto';
    const names = { kazuko: '和子さんへ', kenta: '健太さんへ', both: 'お二人へ' };
    const currentGeneration = generation;
    const controller = new AbortController();
    let latestReply;
    if (!consumeUsage()) {
      announce(usageLimitMessage());
      updateControls();
      return;
    }
    meetingUsage += 1;
    updateInterviewProgress();
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
      questionTargets.push(selected);
      refreshCopyLog();
      render(names[selected] ? `${names[selected]}\n${text}` : text, 'user');
      latestReply = render(data.reply, 'gpt');
      input.value = '';
      announceAfterReply();
    } catch (error) {
      if (currentGeneration !== generation) return;
      const errorMessage = error.name === 'AbortError'
        ? '応答に時間がかかっています。質問は残っています。少し待って再度送信してください。'
        : (error instanceof TypeError ? '接続できませんでした。通信環境を確認して再度送信してください。' : error.message);
      announce(`${errorMessage}${usageLimitMessage() ? ` ${usageLimitMessage()}` : ''}`, true);
    } finally {
      clearTimeout(timeout);
      if (currentGeneration === generation) {
        pending = null;
        updateControls();
        if (latestReply && window.matchMedia?.('(max-width: 600px)').matches) {
          latestReply.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
        } else {
          input.focus();
        }
      }
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
    questionTargets = [];
    meetingUsage = 0;
    totalUsage = readTotalUsage();
    copying = false;
    updateInterviewProgress();
    refreshCopyLog();
    chat.replaceChildren();
    input.value = '';
    if (target) target.value = caseId === 'A' ? 'kazuko' : 'auto';
    // Keep a rate-limit cooldown even when the conversation is reset.
    if (Date.now() >= blockedUntil) announce(usageLimitMessage() || '新しい面談です。質問を入力してください。');
    updateControls(); input.focus();
  });
  window.addEventListener?.('storage', event => {
    if (event.key !== usageKey) return;
    totalUsage = readTotalUsage();
    if (totalUsage >= TOTAL_USAGE_LIMIT) announce(usageLimitMessage());
    updateControls();
  });
  updateInterviewProgress();
  updateControls();
  refreshCopyLog();
  if (totalUsage >= TOTAL_USAGE_LIMIT) announce(usageLimitMessage());
})();
