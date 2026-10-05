import test from 'node:test';
import assert from 'node:assert/strict';
import fileHandler from '../api/submit-file.mjs';
import submissionWorker from '../cloudflare/submission-worker/src/index.mjs';

const CHUNK_SIZE = 4 * 1024 * 1024;
const workerHeaders = { Authorization: 'Bearer submit-secret' };

async function callApi(action, body, headers = {}) {
  const req = {
    method: 'POST',
    url: `/api/submit-file?action=${action}`,
    headers: { host: 'example.test', origin: 'https://example.test', ...headers },
    body
  };
  const res = {
    headers: {},
    setHeader(key, value) { this.headers[key] = value; },
    end(value) { this.body = JSON.parse(value); }
  };
  await fileHandler(req, res);
  return res;
}

function fakeDatabase({ failFileInsert = false } = {}) {
  const fileRows = [];
  return {
    fileRows,
    prepare(sql) {
      if (sql.startsWith('INSERT INTO file_submissions')) return {
        bind(studentId, submittedAt, filename, contentType, fileSize, objectKey) {
          return { async run() {
            if (failFileInsert) throw new Error('D1 failed');
            fileRows.push({ id: fileRows.length + 1, student_id: studentId, submitted_at: submittedAt, original_filename: filename, content_type: contentType, file_size: fileSize, r2_object_key: objectKey });
            return { success: true };
          } };
        }
      };
      if (sql.startsWith('SELECT id, student_id')) return {
        async all() { return { results: [...fileRows].sort((a, b) => b.submitted_at.localeCompare(a.submitted_at) || b.id - a.id).map(({ r2_object_key, ...row }) => row) }; }
      };
      if (sql.startsWith('SELECT original_filename')) return {
        bind(id) { return { async first() { return fileRows.find(row => row.id === id) || null; } }; }
      };
      if (sql.startsWith('INSERT INTO submissions')) return { bind() { return { async run() { return { success: true }; } }; } };
      if (sql.startsWith('SELECT id, student_id, submitted_at, conversation_log')) return { async all() { return { results: [] }; } };
      throw new Error(`Unexpected SQL: ${sql}`);
    }
  };
}

function bytesOf(value) {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new Error('Unexpected R2 value');
}

function fakeBucket() {
  const objects = new Map();
  const multipartParts = [];
  return {
    objects,
    multipartParts,
    async put(key, value, options = {}) {
      objects.set(key, { bytes: bytesOf(value), httpMetadata: options.httpMetadata || {} });
    },
    async get(key) {
      const item = objects.get(key);
      if (!item) return null;
      return {
        size: item.bytes.byteLength,
        body: item.bytes,
        async arrayBuffer() { return item.bytes.buffer.slice(item.bytes.byteOffset, item.bytes.byteOffset + item.bytes.byteLength); }
      };
    },
    async delete(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key);
    },
    async createMultipartUpload(key, options = {}) {
      const parts = new Map();
      let aborted = false;
      return {
        async uploadPart(partNumber, value) {
          const bytes = bytesOf(value);
          parts.set(partNumber, bytes);
          multipartParts.push(bytes.byteLength);
          return { partNumber, etag: `etag-${partNumber}` };
        },
        async complete(uploadedParts) {
          assert.equal(aborted, false);
          const ordered = uploadedParts.map(part => parts.get(part.partNumber));
          const total = ordered.reduce((sum, bytes) => sum + bytes.byteLength, 0);
          const combined = new Uint8Array(total);
          let offset = 0;
          for (const bytes of ordered) { combined.set(bytes, offset); offset += bytes.byteLength; }
          objects.set(key, { bytes: combined, httpMetadata: options.httpMetadata || {} });
          return { key, size: total };
        },
        async abort() { aborted = true; }
      };
    }
  };
}

function workerEnv(options) {
  return {
    SUBMISSION_SHARED_SECRET: 'submit-secret',
    ADMIN_EXPORT_TOKEN: 'admin-secret',
    SUBMISSIONS_DB: fakeDatabase(options),
    SUBMISSION_FILES: fakeBucket()
  };
}

async function workerJson(path, { body, headers = {}, method = 'POST' } = {}, env) {
  const requestHeaders = { ...headers };
  if (body !== undefined && !requestHeaders['Content-Type']) requestHeaders['Content-Type'] = 'application/json';
  const request = new Request(`https://worker.test${path}`, {
    method,
    headers: requestHeaders,
    body: body === undefined ? undefined : (requestHeaders['Content-Type'] === 'application/json' ? JSON.stringify(body) : body)
  });
  return submissionWorker.fetch(request, env);
}

async function submitFile(env, { studentId = '20260001', filename, contentType, bytes }) {
  let response = await workerJson('/file-submissions/init', {
    headers: { ...workerHeaders, 'Content-Type': 'application/json' },
    body: { student_id: studentId, original_filename: filename, content_type: contentType, file_size: bytes.byteLength }
  }, env);
  assert.equal(response.status, 201);
  const { upload_token: uploadToken } = await response.json();
  const count = Math.ceil(bytes.byteLength / CHUNK_SIZE);
  for (let index = 0; index < count; index += 1) {
    const chunk = bytes.slice(index * CHUNK_SIZE, Math.min(bytes.byteLength, (index + 1) * CHUNK_SIZE));
    response = await workerJson('/file-submissions/chunk', {
      headers: { ...workerHeaders, 'Content-Type': 'application/octet-stream', 'X-Upload-Token': uploadToken, 'X-Chunk-Number': String(index + 1) },
      body: chunk
    }, env);
    assert.equal(response.status, 200);
  }
  response = await workerJson('/file-submissions/complete', {
    headers: { ...workerHeaders, 'Content-Type': 'application/json' }, body: { upload_token: uploadToken }
  }, env);
  return response;
}

test('Vercel file API validates metadata and forwards only to the submission Worker', async t => {
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
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    const path = new URL(url).pathname;
    if (path.endsWith('/init')) return new Response(JSON.stringify({ ok: true, upload_token: 'signed-token', chunk_size: CHUNK_SIZE }), { status: 201 });
    if (path.endsWith('/complete')) return new Response(JSON.stringify({ ok: true, student_id: '20260001', original_filename: '課題.pdf', submitted_at: '2026-10-05T00:00:00.000Z' }), { status: 201 });
    return new Response(JSON.stringify({ ok: true, chunk_number: 1 }), { status: 200 });
  };

  for (const metadata of [
    { student_id: '', original_filename: 'a.pdf', content_type: 'application/pdf', file_size: 10 },
    { student_id: '1', original_filename: '', content_type: 'application/pdf', file_size: 10 },
    { student_id: '1', original_filename: 'a.exe', content_type: 'application/octet-stream', file_size: 10 }
  ]) {
    const response = await callApi('init', metadata, { 'content-type': 'application/json' });
    assert.equal(response.statusCode, 400);
  }
  let response = await callApi('init', { student_id: '1', original_filename: 'a.pdf', content_type: 'application/pdf', file_size: 100 * 1024 * 1024 + 1 }, { 'content-type': 'application/json' });
  assert.equal(response.statusCode, 413);
  assert.equal(response.body.code, 'FILE_TOO_LARGE');
  assert.equal(calls.length, 0);

  response = await callApi('init', { student_id: ' 20260001 ', original_filename: '課題.pdf', content_type: 'application/pdf', file_size: 10 }, { 'content-type': 'application/json' });
  assert.equal(response.statusCode, 201);
  response = await callApi('init', { student_id: '20260001', original_filename: '発表.pptx', content_type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', file_size: 10 }, { 'content-type': 'application/json' });
  assert.equal(response.statusCode, 201);
  response = await callApi('init', { student_id: '20260001', original_filename: '写真.jpg', content_type: 'image/jpeg', file_size: 10 }, { 'content-type': 'application/json' });
  assert.equal(response.statusCode, 201);
  response = await callApi('chunk', Buffer.from('1234'), { 'content-type': 'application/octet-stream', 'content-length': '4', 'x-upload-token': 'signed-token', 'x-chunk-number': '1' });
  assert.equal(response.statusCode, 200);
  response = await callApi('complete', { upload_token: 'signed-token' }, { 'content-type': 'application/json' });
  assert.equal(response.statusCode, 201);
  assert.ok(calls.every(call => call.url.startsWith('https://submissions.example.workers.dev/file-submissions/')));
  assert.ok(calls.every(call => !/openai|community-chat/u.test(call.url)));
  assert.ok(calls.every(call => call.options.headers.Authorization === 'Bearer shared-secret'));
});

test('Worker saves PDF and multipart PPTX in private R2 and appends D1 rows for repeat submissions', async () => {
  const env = workerEnv();
  let response = await submitFile(env, { filename: '課題.pdf', contentType: 'application/pdf', bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]) });
  assert.equal(response.status, 201);
  const first = await response.json();
  assert.equal(first.original_filename, '課題.pdf');

  const pptx = new Uint8Array(9 * 1024 * 1024);
  pptx.set([0x50, 0x4b, 0x03, 0x04]);
  response = await submitFile(env, { filename: '発表.pptx', contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', bytes: pptx });
  assert.equal(response.status, 201);
  response = await submitFile(env, { filename: '写真.png', contentType: 'image/png', bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) });
  assert.equal(response.status, 201);
  assert.equal(env.SUBMISSIONS_DB.fileRows.length, 3);
  assert.equal(env.SUBMISSIONS_DB.fileRows[0].student_id, '20260001');
  assert.equal(env.SUBMISSIONS_DB.fileRows[1].student_id, '20260001');
  assert.equal(env.SUBMISSIONS_DB.fileRows[2].original_filename, '写真.png');
  assert.notEqual(env.SUBMISSIONS_DB.fileRows[0].r2_object_key, env.SUBMISSIONS_DB.fileRows[1].r2_object_key);
  assert.deepEqual(env.SUBMISSION_FILES.multipartParts.slice(-3, -1), [8 * 1024 * 1024, 1024 * 1024]);
  assert.equal([...env.SUBMISSION_FILES.objects.keys()].some(key => key.startsWith('pending/')), false);
  for (const row of env.SUBMISSIONS_DB.fileRows) assert.equal(env.SUBMISSION_FILES.objects.has(row.r2_object_key), true);

  response = await submissionWorker.fetch(new Request('https://worker.test/submissions/anything'), env);
  assert.equal(response.status, 404);
});

test('Worker rejects invalid uploads, rolls R2 back after D1 failure, and leaves no public file route', async () => {
  const env = workerEnv({ failFileInsert: true });
  let response = await workerJson('/file-submissions/init', {
    headers: { ...workerHeaders, 'Content-Type': 'application/json' },
    body: { student_id: '1', original_filename: 'bad.exe', content_type: 'application/octet-stream', file_size: 5 }
  }, env);
  assert.equal(response.status, 400);
  response = await workerJson('/file-submissions/init', {
    headers: { ...workerHeaders, 'Content-Type': 'application/json' },
    body: { student_id: '1', original_filename: 'large.pdf', content_type: 'application/pdf', file_size: 100 * 1024 * 1024 + 1 }
  }, env);
  assert.equal(response.status, 413);

  response = await submitFile(env, { filename: 'rollback.pdf', contentType: 'application/pdf', bytes: new Uint8Array([1, 2, 3]) });
  assert.equal(response.status, 500);
  assert.equal(env.SUBMISSIONS_DB.fileRows.length, 0);
  assert.equal(env.SUBMISSION_FILES.objects.size, 0);
});

test('admin list and individual download require Cloudflare Access, sort newest first, and preserve filenames', async () => {
  const env = workerEnv();
  const teacherContext = { access: { async getIdentity() { return { email: 'teacher@example.ac.jp' }; } } };
  await submitFile(env, { studentId: 'A001', filename: '資料.pdf', contentType: 'application/pdf', bytes: new Uint8Array([1, 2]) });
  await submitFile(env, { studentId: 'A002', filename: '発表資料.pptx', contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', bytes: new Uint8Array([3, 4, 5]) });

  let response = await submissionWorker.fetch(new Request('https://worker.test/admin/api/file-submissions'), env);
  assert.equal(response.status, 403);
  response = await submissionWorker.fetch(new Request('https://worker.test/admin/api/file-submissions', { headers: { Authorization: 'Bearer admin-secret' } }), env);
  assert.equal(response.status, 403);
  response = await submissionWorker.fetch(new Request('https://worker.test/admin/api/file-submissions'), env, teacherContext);
  assert.equal(response.status, 200);
  const list = await response.json();
  assert.deepEqual(list.submissions.map(item => item.student_id), ['A002', 'A001']);
  assert.equal(JSON.stringify(list).includes('r2_object_key'), false);

  response = await submissionWorker.fetch(new Request('https://worker.test/admin/api/file-submissions/1/download'), env);
  assert.equal(response.status, 403);
  response = await submissionWorker.fetch(new Request('https://worker.test/admin/api/file-submissions/1/download'), env, teacherContext);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-disposition'), /filename\*=UTF-8''%E8%B3%87%E6%96%99\.pdf/u);
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [1, 2]);

  response = await submissionWorker.fetch(new Request('https://worker.test/admin'), env);
  assert.equal(response.status, 403);
  response = await submissionWorker.fetch(new Request('https://worker.test/admin'), env, teacherContext);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.doesNotMatch(html, /type="password"|ADMIN_EXPORT_TOKEN|adminToken|Authorization/u);
  assert.match(html, /load\(\)\.catch/u);

  response = await submissionWorker.fetch(new Request('https://worker.test/export.csv'), env, teacherContext);
  assert.equal(response.status, 401);
  response = await submissionWorker.fetch(new Request('https://worker.test/export.csv', { headers: { Authorization: 'Bearer admin-secret' } }), env);
  assert.equal(response.status, 200);
});
