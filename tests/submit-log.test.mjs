import test from 'node:test';
import assert from 'node:assert/strict';
import submitHandler from '../api/submit-log.mjs';
import submissionWorker from '../cloudflare/submission-worker/src/index.mjs';

async function callApi(body, headers = {}, method = 'POST') {
  const res = { headers: {}, setHeader(key, value) { this.headers[key] = value; }, end(value) { this.body = JSON.parse(value); } };
  await submitHandler({ method, headers: { host: 'example.test', 'content-type': 'application/json', ...headers }, body }, res);
  return res;
}

function fakeDatabase() {
  const rows = [];
  return {
    rows,
    prepare(sql) {
      if (sql.startsWith('INSERT')) {
        return { bind(studentId, submittedAt, conversationLog) {
          return { async run() { rows.push({ id: rows.length + 1, student_id: studentId, submitted_at: submittedAt, conversation_log: conversationLog }); return { success: true }; } };
        } };
      }
      if (sql.startsWith('SELECT')) return { async all() { return { results: [...rows] }; } };
      throw new Error(`Unexpected SQL: ${sql}`);
    }
  };
}

test('same-origin submission API validates input and only calls the submission Worker', async t => {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.SUBMISSION_WORKER_URL;
  const originalSecret = process.env.SUBMISSION_WORKER_SECRET;
  process.env.SUBMISSION_WORKER_URL = 'https://submissions.example.workers.dev/';
  process.env.SUBMISSION_WORKER_SECRET = 'shared-secret';
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.SUBMISSION_WORKER_URL; else process.env.SUBMISSION_WORKER_URL = originalUrl;
    if (originalSecret === undefined) delete process.env.SUBMISSION_WORKER_SECRET; else process.env.SUBMISSION_WORKER_SECRET = originalSecret;
  });

  let calls = 0;
  const received = [];
  globalThis.fetch = async (url, options) => {
    calls += 1;
    received.push({ url: String(url), options, body: JSON.parse(options.body) });
    return new Response(JSON.stringify({ ok: true, submitted_at: '2026-10-05T03:04:00.000Z' }), { status: 201 });
  };

  for (const body of [
    null,
    {},
    { student_id: '   ', conversation_log: 'log' },
    { student_id: 'x'.repeat(51), conversation_log: 'log' },
    { student_id: '123', conversation_log: '' },
    { student_id: '123', conversation_log: 'x'.repeat(100001) }
  ]) assert.ok((await callApi(body)).statusCode >= 400);
  assert.equal(calls, 0);
  assert.equal((await callApi({ student_id: '123', conversation_log: 'log' }, { origin: 'https://evil.test' })).statusCode, 403);

  const log = '地域包括ケア演習 事例A\n\n【会話ログ】\n看護師：\nこんにちは';
  let response = await callApi({ student_id: '  20260001  ', conversation_log: log }, { origin: 'https://example.test' });
  assert.equal(response.statusCode, 201);
  assert.deepEqual(response.body, { ok: true, submitted_at: '2026-10-05T03:04:00.000Z' });
  assert.equal(received[0].url, 'https://submissions.example.workers.dev/submit-log');
  assert.equal(received[0].options.headers.Authorization, 'Bearer shared-secret');
  assert.deepEqual(received[0].body, { student_id: '20260001', conversation_log: log });
  assert.doesNotMatch(received[0].url, /openai|simulation\.08t-ishikawa/u);

  response = await callApi({ student_id: '20260001', conversation_log: `${log}\n再提出` });
  assert.equal(response.statusCode, 201);
  assert.equal(calls, 2);
});

test('submission Worker appends every submission to D1 and exports protected CSV', async () => {
  const database = fakeDatabase();
  const env = { SUBMISSIONS_DB: database, SUBMISSION_SHARED_SECRET: 'submit-secret', ADMIN_EXPORT_TOKEN: 'admin-secret' };
  const submit = log => submissionWorker.fetch(new Request('https://worker.test/submit-log', {
    method: 'POST',
    headers: { Authorization: 'Bearer submit-secret', 'Content-Type': 'application/json' },
    body: JSON.stringify({ student_id: '20260001', conversation_log: log })
  }), env);

  let response = await submit('地域包括ケア演習 事例A\n会話1');
  assert.equal(response.status, 201);
  const first = await response.json();
  assert.equal(first.ok, true);
  assert.match(first.submitted_at, /^\d{4}-\d{2}-\d{2}T/u);

  response = await submit('地域包括ケア演習 事例A\n会話2,「再提出」');
  assert.equal(response.status, 201);
  assert.equal(database.rows.length, 2);
  assert.equal(database.rows[0].student_id, '20260001');
  assert.equal(database.rows[1].student_id, '20260001');
  assert.notEqual(database.rows[0].id, database.rows[1].id);

  response = await submissionWorker.fetch(new Request('https://worker.test/export.csv'), env);
  assert.equal(response.status, 401);
  response = await submissionWorker.fetch(new Request('https://worker.test/export.csv', { headers: { Authorization: 'Bearer admin-secret' } }), env);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/csv/u);
  assert.match(response.headers.get('content-disposition'), /attachment/u);
  const bytes = new Uint8Array(await response.clone().arrayBuffer());
  assert.deepEqual([...bytes.slice(0, 3)], [0xEF, 0xBB, 0xBF]);
  const csv = await response.text();
  assert.match(csv, /^"id","student_id","submitted_at","conversation_log"/u);
  assert.match(csv, /"地域包括ケア演習 事例A\n会話1"/u);
  assert.match(csv, /会話2,「再提出」/u);
});

test('submission Worker rejects invalid or unauthenticated writes without touching D1', async () => {
  const database = fakeDatabase();
  const env = { SUBMISSIONS_DB: database, SUBMISSION_SHARED_SECRET: 'submit-secret', ADMIN_EXPORT_TOKEN: 'admin-secret' };
  let response = await submissionWorker.fetch(new Request('https://worker.test/submit-log', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"student_id":"1","conversation_log":"log"}'
  }), env);
  assert.equal(response.status, 401);
  response = await submissionWorker.fetch(new Request('https://worker.test/submit-log', {
    method: 'POST', headers: { Authorization: 'Bearer submit-secret', 'Content-Type': 'application/json' }, body: '{"student_id":"","conversation_log":"log"}'
  }), env);
  assert.equal(response.status, 400);
  assert.equal(database.rows.length, 0);
});
