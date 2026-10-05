const MAX_FILE_SIZE = 100 * 1024 * 1024;
const CHUNK_SIZE = 4 * 1024 * 1024;
const MAX_JSON_BYTES = 32 * 1024;
const MAX_TOKEN_LENGTH = 4096;
const ALLOWED_EXTENSIONS = new Set(['.pdf', '.pptx', '.jpg', '.jpeg', '.png', '.heic', '.heif', '.webp']);
const ALLOWED_CONTENT_TYPES = new Set([
  '',
  'application/octet-stream',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'image/jpeg',
  'image/png',
  'image/heic',
  'image/heif',
  'image/webp'
]);

function respond(res, status, data) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify(data));
}

function extension(filename) {
  const index = filename.lastIndexOf('.');
  return index >= 0 ? filename.slice(index).toLowerCase() : '';
}

function sameOrigin(req) {
  if (!req.headers.origin) return true;
  try {
    return new URL(req.headers.origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function parseJsonBody(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new Error('JSON_REQUIRED');
  if (Number(req.headers['content-length']) > MAX_JSON_BYTES) throw new Error('JSON_TOO_LARGE');
  const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('INVALID_JSON');
  return body;
}

async function readBinaryBody(req) {
  if (!req.headers['content-type']?.startsWith('application/octet-stream')) throw new Error('BINARY_REQUIRED');
  if (Number(req.headers['content-length']) > CHUNK_SIZE) throw new Error('CHUNK_TOO_LARGE');
  if (Buffer.isBuffer(req.body)) return req.body;
  if (req.body instanceof Uint8Array) return Buffer.from(req.body);
  if (req.body instanceof ArrayBuffer) return Buffer.from(req.body);
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > CHUNK_SIZE) throw new Error('CHUNK_TOO_LARGE');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function validInit(body) {
  const studentId = typeof body.student_id === 'string' ? body.student_id.trim() : '';
  const filename = typeof body.original_filename === 'string' ? body.original_filename.trim() : '';
  const contentType = typeof body.content_type === 'string' ? body.content_type.toLowerCase() : '';
  const fileSize = Number(body.file_size);
  if (!studentId || studentId.length > 50 || !filename || filename.length > 255) return null;
  if (!ALLOWED_EXTENSIONS.has(extension(filename)) || !ALLOWED_CONTENT_TYPES.has(contentType)) return null;
  if (!Number.isSafeInteger(fileSize) || fileSize <= 0) return null;
  if (fileSize > MAX_FILE_SIZE) return { tooLarge: true };
  return { student_id: studentId, original_filename: filename, content_type: contentType, file_size: fileSize };
}

async function callWorker(workerUrl, workerSecret, path, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(new URL(path, workerUrl), {
      ...options,
      headers: { ...options.headers, Authorization: `Bearer ${workerSecret}` },
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return respond(res, 405, { error: 'POSTで送信してください。' });
  }
  if (!sameOrigin(req)) return respond(res, 403, { error: 'このページから送信してください。' });

  const workerUrl = process.env.SUBMISSION_WORKER_URL?.trim();
  const workerSecret = process.env.SUBMISSION_WORKER_SECRET?.trim();
  if (!workerUrl || !workerSecret) return respond(res, 503, { error: '提出機能は準備中です。担当教員にお知らせください。' });

  let action;
  try {
    action = new URL(req.url || '/', `https://${req.headers.host || 'localhost'}`).searchParams.get('action');
  } catch {
    return respond(res, 400, { error: '送信内容を確認してください。' });
  }
  if (!['init', 'chunk', 'complete', 'abort'].includes(action)) return respond(res, 400, { error: '送信内容を確認してください。' });

  try {
    let upstream;
    if (action === 'init') {
      const body = parseJsonBody(req);
      const normalized = validInit(body);
      if (normalized?.tooLarge) return respond(res, 413, { code: 'FILE_TOO_LARGE', error: 'ファイルサイズが大きすぎます。' });
      if (!normalized) return respond(res, 400, { code: 'INVALID_FILE', error: '学籍番号とファイルを確認してください。' });
      upstream = await callWorker(workerUrl, workerSecret, '/file-submissions/init', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(normalized)
      }, 15000);
    } else if (action === 'chunk') {
      const uploadToken = req.headers['x-upload-token'];
      const chunkNumber = Number(req.headers['x-chunk-number']);
      if (typeof uploadToken !== 'string' || !uploadToken || uploadToken.length > MAX_TOKEN_LENGTH ||
          !Number.isInteger(chunkNumber) || chunkNumber < 1 || chunkNumber > 25) {
        return respond(res, 400, { code: 'INVALID_UPLOAD', error: 'アップロード情報を確認してください。' });
      }
      const chunk = await readBinaryBody(req);
      if (!chunk.length) return respond(res, 400, { code: 'INVALID_CHUNK', error: '空のデータは送信できません。' });
      upstream = await callWorker(workerUrl, workerSecret, '/file-submissions/chunk', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(chunk.length),
          'X-Upload-Token': uploadToken,
          'X-Chunk-Number': String(chunkNumber)
        },
        body: chunk
      }, 60000);
    } else {
      const body = parseJsonBody(req);
      const uploadToken = body.upload_token;
      if (typeof uploadToken !== 'string' || !uploadToken || uploadToken.length > MAX_TOKEN_LENGTH) {
        return respond(res, 400, { code: 'INVALID_UPLOAD', error: 'アップロード情報を確認してください。' });
      }
      upstream = await callWorker(workerUrl, workerSecret, `/file-submissions/${action}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ upload_token: uploadToken })
      }, action === 'complete' ? 120000 : 15000);
    }

    const data = await upstream.json().catch(() => ({}));
    if (!upstream.ok || data.ok !== true) {
      const status = upstream.status >= 400 && upstream.status < 500 ? upstream.status : 502;
      return respond(res, status, {
        code: typeof data.code === 'string' ? data.code : 'UPLOAD_FAILED',
        error: status === 413 ? 'ファイルサイズが大きすぎます。' : '提出先で処理できませんでした。'
      });
    }
    return respond(res, upstream.status, data);
  } catch (error) {
    if (['JSON_REQUIRED', 'JSON_TOO_LARGE', 'INVALID_JSON', 'BINARY_REQUIRED'].includes(error.message)) {
      return respond(res, 400, { code: 'INVALID_REQUEST', error: '送信内容を確認してください。' });
    }
    if (error.message === 'CHUNK_TOO_LARGE') return respond(res, 413, { code: 'FILE_TOO_LARGE', error: '送信データが大きすぎます。' });
    return respond(res, error.name === 'AbortError' ? 504 : 502, { code: 'UPLOAD_FAILED', error: '提出先に接続できませんでした。' });
  }
}
