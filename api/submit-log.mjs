const MAX_LOG_CHARS = 100000;
const MAX_BODY_BYTES = 350000;
const TIMEOUT_MS = 10000;

function respond(res, code, data) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify(data));
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return respond(res, 405, { error: 'POSTで送信してください。' });
  }
  if (req.headers.origin) {
    try {
      if (new URL(req.headers.origin).host !== req.headers.host) return respond(res, 403, { error: 'このページから送信してください。' });
    } catch {
      return respond(res, 403, { error: '送信元を確認できません。' });
    }
  }
  if (!req.headers['content-type']?.startsWith('application/json')) return respond(res, 415, { error: 'JSON形式で送信してください。' });
  if (Number(req.headers['content-length']) > MAX_BODY_BYTES) return respond(res, 413, { error: '会話ログが大きすぎます。' });

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch {
    return respond(res, 400, { error: '送信内容を確認してください。' });
  }
  const studentId = typeof body?.student_id === 'string' ? body.student_id.trim() : '';
  const conversationLog = body?.conversation_log;
  if (!studentId || studentId.length > 50 || typeof conversationLog !== 'string' || !conversationLog.trim()) {
    return respond(res, 400, { error: '学籍番号と会話ログを確認してください。' });
  }
  if (conversationLog.length > MAX_LOG_CHARS) return respond(res, 413, { error: '会話ログが大きすぎます。' });

  const workerUrl = process.env.SUBMISSION_WORKER_URL?.trim();
  const workerSecret = process.env.SUBMISSION_WORKER_SECRET?.trim();
  if (!workerUrl || !workerSecret) return respond(res, 503, { error: '提出機能は準備中です。担当教員にお知らせください。' });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(new URL('/submit-log', workerUrl), {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${workerSecret}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ student_id: studentId, conversation_log: conversationLog }),
      signal: controller.signal
    });
    const data = await response.json().catch(() => null);
    if ([400, 413, 415].includes(response.status)) {
      return respond(res, response.status === 413 ? 413 : 400, { error: '学籍番号と会話ログを確認してください。' });
    }
    if (!response.ok || data?.ok !== true || typeof data.submitted_at !== 'string') {
      return respond(res, 502, { error: '提出先に接続できませんでした。' });
    }
    return respond(res, 201, { ok: true, submitted_at: data.submitted_at });
  } catch {
    return respond(res, 504, { error: '提出先への接続に時間がかかっています。' });
  } finally {
    clearTimeout(timer);
  }
}
