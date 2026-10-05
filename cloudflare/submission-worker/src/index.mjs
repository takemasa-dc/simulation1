const MAX_LOG_CHARS = 100000;
const MAX_BODY_BYTES = 350000;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    }
  });
}

function authorized(request, secret) {
  const supplied = request.headers.get('Authorization') || '';
  const expected = `Bearer ${secret || ''}`;
  if (!secret || supplied.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < supplied.length; index += 1) difference |= supplied.charCodeAt(index) ^ expected.charCodeAt(index);
  return difference === 0;
}

function csvCell(value) {
  let text = String(value ?? '');
  if (/^[=+\-@\t\r]/u.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

async function saveSubmission(request, env) {
  if (!authorized(request, env.SUBMISSION_SHARED_SECRET)) return json({ error: 'Unauthorized' }, 401);
  if (!request.headers.get('content-type')?.startsWith('application/json')) return json({ error: 'JSON required' }, 415);
  if (Number(request.headers.get('content-length')) > MAX_BODY_BYTES) return json({ error: 'Payload too large' }, 413);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }
  const studentId = typeof body?.student_id === 'string' ? body.student_id.trim() : '';
  const conversationLog = body?.conversation_log;
  if (!studentId || studentId.length > 50 || typeof conversationLog !== 'string' || !conversationLog.trim()) {
    return json({ error: 'Invalid submission' }, 400);
  }
  if (conversationLog.length > MAX_LOG_CHARS) return json({ error: 'Payload too large' }, 413);

  const submittedAt = new Date().toISOString();
  await env.SUBMISSIONS_DB.prepare(
    'INSERT INTO submissions (student_id, submitted_at, conversation_log) VALUES (?1, ?2, ?3)'
  ).bind(studentId, submittedAt, conversationLog).run();
  return json({ ok: true, submitted_at: submittedAt }, 201);
}

async function exportCsv(request, env) {
  if (!authorized(request, env.ADMIN_EXPORT_TOKEN)) return json({ error: 'Unauthorized' }, 401);
  const { results = [] } = await env.SUBMISSIONS_DB.prepare(
    'SELECT id, student_id, submitted_at, conversation_log FROM submissions ORDER BY submitted_at ASC, id ASC'
  ).all();
  const rows = [
    ['id', 'student_id', 'submitted_at', 'conversation_log'],
    ...results.map(row => [row.id, row.student_id, row.submitted_at, row.conversation_log])
  ];
  const csv = `\uFEFF${rows.map(row => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
  const stamp = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="submissions-${stamp}.csv"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    }
  });
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    try {
      if (pathname === '/submit-log' && request.method === 'POST') return await saveSubmission(request, env);
      if (pathname === '/export.csv' && request.method === 'GET') return await exportCsv(request, env);
      return json({ error: 'Not found' }, 404);
    } catch {
      return json({ error: 'Internal error' }, 500);
    }
  }
};
