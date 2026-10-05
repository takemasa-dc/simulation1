const MAX_LOG_CHARS = 100000;
const MAX_BODY_BYTES = 350000;
const MAX_FILE_SIZE = 100 * 1024 * 1024;
const CHUNK_SIZE = 4 * 1024 * 1024;
const TOKEN_TTL_MS = 2 * 60 * 60 * 1000;
const ALLOWED_EXTENSIONS = new Set(['.pdf', '.pptx', '.docx', '.doc', '.jpg', '.jpeg', '.png', '.heic', '.heif', '.webp']);
const ALLOWED_CONTENT_TYPES = new Set([
  '',
  'application/octet-stream',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
  'image/jpeg',
  'image/png',
  'image/heic',
  'image/heif',
  'image/webp'
]);

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

function extension(filename) {
  const index = filename.lastIndexOf('.');
  return index >= 0 ? filename.slice(index).toLowerCase() : '';
}

function normalizedFile(body) {
  const studentId = typeof body?.student_id === 'string' ? body.student_id.trim() : '';
  const originalFilename = typeof body?.original_filename === 'string' ? body.original_filename.trim() : '';
  const contentType = typeof body?.content_type === 'string' ? body.content_type.toLowerCase() : '';
  const fileSize = Number(body?.file_size);
  if (!studentId || studentId.length > 50 || !originalFilename || originalFilename.length > 255) return null;
  if (!ALLOWED_EXTENSIONS.has(extension(originalFilename)) || !ALLOWED_CONTENT_TYPES.has(contentType)) return null;
  if (!Number.isSafeInteger(fileSize) || fileSize <= 0 || fileSize > MAX_FILE_SIZE) return null;
  return { studentId, originalFilename, contentType, fileSize };
}

function safeSegment(value, fallback) {
  const cleaned = value.normalize('NFKC').replace(/[^\p{L}\p{N}._-]+/gu, '_').replace(/^[_\.]+|[_\.]+$/gu, '');
  return cleaned.slice(0, 80) || fallback;
}

function base64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function fromBase64Url(text) {
  const normalized = text.replaceAll('-', '+').replaceAll('_', '/');
  const binary = atob(normalized + '='.repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

async function createUploadToken(payload, secret) {
  const encodedPayload = base64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign('HMAC', await hmacKey(secret), new TextEncoder().encode(encodedPayload));
  return `${encodedPayload}.${base64Url(new Uint8Array(signature))}`;
}

async function readUploadToken(token, secret) {
  if (!secret || typeof token !== 'string' || token.length > 4096) return null;
  const [encodedPayload, encodedSignature, extra] = token.split('.');
  if (!encodedPayload || !encodedSignature || extra) return null;
  try {
    const valid = await crypto.subtle.verify(
      'HMAC', await hmacKey(secret), fromBase64Url(encodedSignature), new TextEncoder().encode(encodedPayload)
    );
    if (!valid) return null;
    const payload = JSON.parse(new TextDecoder().decode(fromBase64Url(encodedPayload)));
    if (!payload || payload.expires_at < Date.now() || payload.chunk_size !== CHUNK_SIZE ||
        !Number.isSafeInteger(payload.file_size) || payload.file_size <= 0 || payload.file_size > MAX_FILE_SIZE) return null;
    return payload;
  } catch {
    return null;
  }
}

function pendingKeys(payload) {
  return Array.from({ length: payload.chunk_count }, (_, index) => `pending/${payload.session_id}/${index + 1}`);
}

async function deletePending(env, payload) {
  try {
    await env.SUBMISSION_FILES.delete(pendingKeys(payload));
  } catch {
    // A bucket lifecycle rule removes stale pending objects if cleanup is interrupted.
  }
}

async function saveSubmission(request, env) {
  if (!authorized(request, env.SUBMISSION_SHARED_SECRET)) return json({ error: 'Unauthorized' }, 401);
  if (!request.headers.get('content-type')?.startsWith('application/json')) return json({ error: 'JSON required' }, 415);
  if (Number(request.headers.get('content-length')) > MAX_BODY_BYTES) return json({ error: 'Payload too large' }, 413);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
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

async function initializeFileUpload(request, env) {
  if (!authorized(request, env.SUBMISSION_SHARED_SECRET)) return json({ error: 'Unauthorized' }, 401);
  let body;
  try { body = await request.json(); } catch { return json({ code: 'INVALID_FILE', error: 'Invalid JSON' }, 400); }
  if (Number(body?.file_size) > MAX_FILE_SIZE) return json({ code: 'FILE_TOO_LARGE', error: 'Payload too large' }, 413);
  const file = normalizedFile(body);
  if (!file) return json({ code: 'INVALID_FILE', error: 'Invalid file' }, 400);
  const sessionId = crypto.randomUUID();
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/gu, '');
  const filename = safeSegment(file.originalFilename, `assignment${extension(file.originalFilename)}`);
  const objectKey = `submissions/${timestamp}-${sessionId}/${safeSegment(file.studentId, 'student')}/${filename}`;
  const payload = {
    session_id: sessionId,
    object_key: objectKey,
    student_id: file.studentId,
    original_filename: file.originalFilename,
    content_type: file.contentType,
    file_size: file.fileSize,
    chunk_size: CHUNK_SIZE,
    chunk_count: Math.ceil(file.fileSize / CHUNK_SIZE),
    expires_at: Date.now() + TOKEN_TTL_MS
  };
  return json({
    ok: true,
    upload_token: await createUploadToken(payload, env.SUBMISSION_SHARED_SECRET),
    chunk_size: CHUNK_SIZE
  }, 201);
}

async function saveFileChunk(request, env) {
  if (!authorized(request, env.SUBMISSION_SHARED_SECRET)) return json({ error: 'Unauthorized' }, 401);
  const payload = await readUploadToken(request.headers.get('X-Upload-Token'), env.SUBMISSION_SHARED_SECRET);
  const chunkNumber = Number(request.headers.get('X-Chunk-Number'));
  if (!payload || !Number.isInteger(chunkNumber) || chunkNumber < 1 || chunkNumber > payload.chunk_count) {
    return json({ code: 'INVALID_UPLOAD', error: 'Invalid upload' }, 400);
  }
  if (!request.headers.get('content-type')?.startsWith('application/octet-stream')) {
    return json({ code: 'INVALID_CHUNK', error: 'Binary required' }, 415);
  }
  const expectedSize = chunkNumber === payload.chunk_count
    ? payload.file_size - CHUNK_SIZE * (payload.chunk_count - 1)
    : CHUNK_SIZE;
  if (Number(request.headers.get('content-length')) > expectedSize) return json({ code: 'INVALID_CHUNK', error: 'Invalid chunk size' }, 400);
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength !== expectedSize) return json({ code: 'INVALID_CHUNK', error: 'Invalid chunk size' }, 400);
  await env.SUBMISSION_FILES.put(`pending/${payload.session_id}/${chunkNumber}`, bytes, {
    httpMetadata: { contentType: 'application/octet-stream' }
  });
  return json({ ok: true, chunk_number: chunkNumber });
}

async function completeFileUpload(request, env) {
  if (!authorized(request, env.SUBMISSION_SHARED_SECRET)) return json({ error: 'Unauthorized' }, 401);
  let body;
  try { body = await request.json(); } catch { return json({ code: 'INVALID_UPLOAD', error: 'Invalid JSON' }, 400); }
  const payload = await readUploadToken(body?.upload_token, env.SUBMISSION_SHARED_SECRET);
  if (!payload) return json({ code: 'INVALID_UPLOAD', error: 'Invalid upload' }, 400);
  let multipart;
  let completed = false;
  try {
    multipart = await env.SUBMISSION_FILES.createMultipartUpload(payload.object_key, {
      httpMetadata: { contentType: payload.content_type || 'application/octet-stream' }
    });
    const uploadedParts = [];
    let totalSize = 0;
    for (let chunkIndex = 1, partNumber = 1; chunkIndex <= payload.chunk_count; partNumber += 1) {
      const buffers = [];
      for (let grouped = 0; grouped < 2 && chunkIndex <= payload.chunk_count; grouped += 1, chunkIndex += 1) {
        const object = await env.SUBMISSION_FILES.get(`pending/${payload.session_id}/${chunkIndex}`);
        if (!object) throw new Error('MISSING_CHUNK');
        const bytes = new Uint8Array(await object.arrayBuffer());
        const expectedSize = chunkIndex === payload.chunk_count
          ? payload.file_size - CHUNK_SIZE * (payload.chunk_count - 1)
          : CHUNK_SIZE;
        if (bytes.byteLength !== expectedSize) throw new Error('INVALID_CHUNK');
        buffers.push(bytes);
        totalSize += bytes.byteLength;
      }
      const partSize = buffers.reduce((sum, bytes) => sum + bytes.byteLength, 0);
      const combined = new Uint8Array(partSize);
      let offset = 0;
      for (const bytes of buffers) {
        combined.set(bytes, offset);
        offset += bytes.byteLength;
      }
      uploadedParts.push(await multipart.uploadPart(partNumber, combined));
    }
    if (totalSize !== payload.file_size) throw new Error('INVALID_SIZE');
    const object = await multipart.complete(uploadedParts);
    completed = true;
    if (object.size !== undefined && object.size !== payload.file_size) throw new Error('INVALID_SIZE');
    const submittedAt = new Date().toISOString();
    try {
      await env.SUBMISSIONS_DB.prepare(
        'INSERT INTO file_submissions (student_id, submitted_at, original_filename, content_type, file_size, r2_object_key) VALUES (?1, ?2, ?3, ?4, ?5, ?6)'
      ).bind(payload.student_id, submittedAt, payload.original_filename, payload.content_type || null, payload.file_size, payload.object_key).run();
    } catch (error) {
      await env.SUBMISSION_FILES.delete(payload.object_key);
      throw error;
    }
    await deletePending(env, payload);
    return json({ ok: true, student_id: payload.student_id, original_filename: payload.original_filename, submitted_at: submittedAt }, 201);
  } catch (error) {
    if (multipart && !completed) { try { await multipart.abort(); } catch {} }
    if (completed) { try { await env.SUBMISSION_FILES.delete(payload.object_key); } catch {} }
    await deletePending(env, payload);
    return json({ code: error.message === 'MISSING_CHUNK' ? 'MISSING_CHUNK' : 'UPLOAD_FAILED', error: 'Upload failed' }, 500);
  }
}

async function abortFileUpload(request, env) {
  if (!authorized(request, env.SUBMISSION_SHARED_SECRET)) return json({ error: 'Unauthorized' }, 401);
  let body;
  try { body = await request.json(); } catch { return json({ code: 'INVALID_UPLOAD', error: 'Invalid JSON' }, 400); }
  const payload = await readUploadToken(body?.upload_token, env.SUBMISSION_SHARED_SECRET);
  if (!payload) return json({ code: 'INVALID_UPLOAD', error: 'Invalid upload' }, 400);
  await deletePending(env, payload);
  return json({ ok: true });
}

async function exportCsv(request, env) {
  if (!authorized(request, env.ADMIN_EXPORT_TOKEN)) return json({ error: 'Unauthorized' }, 401);
  const { results = [] } = await env.SUBMISSIONS_DB.prepare(
    'SELECT id, student_id, submitted_at, conversation_log FROM submissions ORDER BY submitted_at ASC, id ASC'
  ).all();
  const rows = [['id', 'student_id', 'submitted_at', 'conversation_log'], ...results.map(row => [row.id, row.student_id, row.submitted_at, row.conversation_log])];
  const csv = `\uFEFF${rows.map(row => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
  const stamp = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  return new Response(csv, { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="submissions-${stamp}.csv"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}

function adminPage() {
  return new Response(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>課題ファイル提出一覧</title><style>body{font-family:system-ui,sans-serif;margin:0;background:#f5f7f5;color:#26332d}main{max-width:1100px;margin:auto;padding:1rem}.panel{background:#fff;border:1px solid #ccd6cf;border-radius:8px;padding:1rem;margin-bottom:1rem}button{font:inherit;font-size:16px;padding:.6rem;border:1px solid #2e713d;border-radius:6px;background:#327b42;color:#fff;cursor:pointer}button:disabled{opacity:.55}table{width:100%;border-collapse:collapse;background:#fff}th,td{text-align:left;padding:.6rem;border-bottom:1px solid #dde3de;vertical-align:top}#status{min-height:1.5em}.error{color:#a02424}@media(max-width:700px){table,thead,tbody,tr,th,td{display:block}thead{position:absolute;left:-9999px}tr{border:1px solid #ccd6cf;margin-bottom:.75rem}td::before{content:attr(data-label);font-weight:600;display:block}}</style></head><body><main><h1>課題ファイル提出一覧</h1><p id="status" role="status">読み込んでいます…</p><div id="panel" class="panel" hidden><button id="refresh" type="button">最新の一覧に更新</button><table><thead><tr><th>学籍番号</th><th>提出日時</th><th>ファイル名</th><th>サイズ</th><th></th></tr></thead><tbody id="rows"></tbody></table></div></main><script>(()=>{'use strict';const status=document.getElementById('status'),panel=document.getElementById('panel'),rows=document.getElementById('rows'),refresh=document.getElementById('refresh');const date=value=>{const d=new Date(value);return Number.isNaN(d.getTime())?value:d.toLocaleString('ja-JP')};const size=value=>value>=1048576?(value/1048576).toFixed(1)+' MB':Math.ceil(value/1024)+' KB';function cell(row,label,text){const td=document.createElement('td');td.dataset.label=label;td.textContent=text;row.append(td)}async function load(){status.textContent='読み込んでいます…';status.className='';const response=await fetch('/admin/api/file-submissions');if(!response.ok)throw new Error('ACCESS');const data=await response.json();rows.replaceChildren();for(const item of data.submissions){const row=document.createElement('tr');cell(row,'学籍番号',item.student_id);cell(row,'提出日時',date(item.submitted_at));cell(row,'ファイル名',item.original_filename);cell(row,'サイズ',size(item.file_size));const action=document.createElement('td');action.dataset.label='操作';const button=document.createElement('button');button.type='button';button.textContent='ダウンロード';button.addEventListener('click',()=>download(item,button));action.append(button);row.append(action);rows.append(row)}panel.hidden=false;status.textContent=data.submissions.length+'件の提出があります．'}async function download(item,button){button.disabled=true;status.textContent='ダウンロードを準備しています…';try{const response=await fetch('/admin/api/file-submissions/'+item.id+'/download');if(!response.ok)throw new Error('DOWNLOAD');const blob=await response.blob();const url=URL.createObjectURL(blob);const link=document.createElement('a');link.href=url;link.download=item.original_filename;document.body.append(link);link.click();link.remove();URL.revokeObjectURL(url);status.textContent=item.original_filename+'をダウンロードしました．'}catch{status.textContent='ダウンロードできませんでした．Cloudflare Accessの認証状態を確認してください．';status.className='error'}finally{button.disabled=false}}function showLoadError(){panel.hidden=true;status.textContent='一覧を取得できませんでした．Cloudflare Accessの認証状態を確認してください．';status.className='error'}refresh.addEventListener('click',()=>load().catch(showLoadError));load().catch(showLoadError);})();</script></body></html>`, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'" } });
}

async function accessIdentity(ctx) {
  if (!ctx?.access) return null;
  try {
    const identity = await ctx.access.getIdentity();
    return typeof identity?.email === 'string' && identity.email ? identity : null;
  } catch {
    return null;
  }
}

async function listFileSubmissions(env) {
  const { results = [] } = await env.SUBMISSIONS_DB.prepare('SELECT id, student_id, submitted_at, original_filename, content_type, file_size FROM file_submissions ORDER BY submitted_at DESC, id DESC').all();
  return json({ ok: true, submissions: results });
}

function downloadFilename(filename) {
  const ascii = safeSegment(filename.replace(/[^\x20-\x7E]/gu, '_'), 'assignment').replaceAll('"', '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

async function downloadFile(env, id) {
  const row = await env.SUBMISSIONS_DB.prepare('SELECT original_filename, content_type, r2_object_key FROM file_submissions WHERE id = ?1').bind(id).first();
  if (!row) return json({ error: 'Not found' }, 404);
  const object = await env.SUBMISSION_FILES.get(row.r2_object_key);
  if (!object) return json({ error: 'Not found' }, 404);
  return new Response(object.body, { headers: { 'Content-Type': row.content_type || 'application/octet-stream', 'Content-Length': String(object.size), 'Content-Disposition': downloadFilename(row.original_filename), 'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff' } });
}

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    try {
      if (pathname === '/submit-log' && request.method === 'POST') return await saveSubmission(request, env);
      if (pathname === '/export.csv' && request.method === 'GET') return await exportCsv(request, env);
      if (pathname === '/file-submissions/init' && request.method === 'POST') return await initializeFileUpload(request, env);
      if (pathname === '/file-submissions/chunk' && request.method === 'POST') return await saveFileChunk(request, env);
      if (pathname === '/file-submissions/complete' && request.method === 'POST') return await completeFileUpload(request, env);
      if (pathname === '/file-submissions/abort' && request.method === 'POST') return await abortFileUpload(request, env);
      if (pathname === '/admin' || pathname.startsWith('/admin/')) {
        if (!await accessIdentity(ctx)) return json({ error: 'Cloudflare Access required' }, 403);
      }
      if (pathname === '/admin' && request.method === 'GET') return adminPage();
      if (pathname === '/admin/api/file-submissions' && request.method === 'GET') return await listFileSubmissions(env);
      const downloadMatch = pathname.match(/^\/admin\/api\/file-submissions\/(\d+)\/download$/u);
      if (downloadMatch && request.method === 'GET') return await downloadFile(env, Number(downloadMatch[1]));
      return json({ error: 'Not found' }, 404);
    } catch {
      return json({ error: 'Internal error' }, 500);
    }
  }
};
