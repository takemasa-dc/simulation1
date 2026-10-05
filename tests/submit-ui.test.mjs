import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../submit.js', import.meta.url), 'utf8');

function page() {
  const elements = {};
  const make = () => ({
    value: '', textContent: '', className: '', disabled: false, hidden: true, files: [], events: {},
    addEventListener(name, fn) { this.events[name] = fn; },
    focus() { this.focused = true; },
    requestSubmit() { return this.events.submit({ preventDefault() {} }); }
  });
  for (const id of ['assignmentForm', 'studentId', 'assignmentFile', 'submitAssignment', 'uploadProgress', 'submissionStatus']) {
    elements[id] = make();
  }
  let fileInputValue = '';
  Object.defineProperty(elements.assignmentFile, 'value', {
    get() { return fileInputValue; },
    set(value) { fileInputValue = value; if (value === '') this.files = []; }
  });
  const requests = [];
  vm.runInNewContext(source, {
    document: { getElementById: id => elements[id] },
    AbortController, Date, Error, Set,
    setTimeout: () => 1, clearTimeout() {},
    fetch: (url, options) => new Promise((resolve, reject) => requests.push({ url, options, resolve, reject }))
  });
  return { elements, requests, submit: () => elements.assignmentForm.requestSubmit() };
}

function assignment(name, type, size) {
  return { name, type, size, slice(start, end) { return { start, end, size: end - start }; } };
}

async function waitForRequests(state, count) {
  for (let attempt = 0; attempt < 20 && state.requests.length < count; attempt += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.ok(state.requests.length >= count, `expected ${count} requests, received ${state.requests.length}`);
}

test('the standalone submission page contains only assignment submission controls', () => {
  const html = readFileSync(new URL('../submit.html', import.meta.url), 'utf8');
  assert.match(html, /id="studentId"[^>]*maxlength="50"/u);
  assert.match(html, /id="assignmentFile"[^>]*\.pptx,[^>]*\.pdf/u);
  assert.match(html, /id="assignmentFile"[^>]*\.jpg,[^>]*\.jpeg,[^>]*\.png,[^>]*multiple/u);
  assert.match(html, /4ファイル以上は、3ファイル以内に分けて提出してください/u);
  assert.match(html, /id="submitAssignment"[^>]*>課題を提出</u);
  assert.doesNotMatch(html, /会話ログ|事例A|事例B|面談時間|relationship/u);

  for (const filename of ['caseA.html', 'caseB.html']) {
    const caseHtml = readFileSync(new URL(`../${filename}`, import.meta.url), 'utf8');
    assert.doesNotMatch(caseHtml, /assignmentFile|submitAssignment|課題ファイル/u);
  }
  const communityScript = readFileSync(new URL('../community.js', import.meta.url), 'utf8');
  assert.doesNotMatch(communityScript, /submit-file|FILE_CHUNK_SIZE|assignmentFile/u);
});

test('standalone submission validates student ID, file type, and 100MB limit before requests', async () => {
  const state = page();
  const elements = state.elements;
  await state.submit();
  assert.match(elements.submissionStatus.textContent, /学籍番号を入力/u);

  elements.studentId.value = 'TEST001';
  elements.studentId.events.input();
  await state.submit();
  assert.match(elements.submissionStatus.textContent, /課題ファイルを選択/u);

  elements.assignmentFile.files = [assignment('課題.exe', 'application/octet-stream', 10)];
  elements.assignmentFile.events.change();
  await state.submit();
  assert.match(elements.submissionStatus.textContent, /PowerPoint/u);

  elements.assignmentFile.files = [assignment('課題.pdf', 'application/pdf', 100 * 1024 * 1024 + 1)];
  elements.assignmentFile.events.change();
  await state.submit();
  assert.match(elements.submissionStatus.textContent, /100MB以下/u);

  elements.assignmentFile.files = [1, 2, 3, 4].map(index => assignment(`画像${index}.jpg`, 'image/jpeg', 10));
  elements.assignmentFile.events.change();
  await state.submit();
  assert.match(elements.submissionStatus.textContent, /3つまで/u);
  assert.match(elements.submissionStatus.textContent, /分けて提出/u);
  assert.equal(state.requests.length, 0);
});

test('standalone submission accepts and sequentially saves up to three images', async () => {
  const state = page();
  const elements = state.elements;
  elements.studentId.value = 'IMAGE001';
  elements.studentId.events.input();
  const files = [
    assignment('写真.jpg', 'image/jpeg', 3),
    assignment('図.png', 'image/png', 4),
    assignment('記録.heic', 'image/heic', 5)
  ];
  elements.assignmentFile.files = files;
  elements.assignmentFile.events.change();

  const upload = state.submit();
  for (let index = 0; index < files.length; index += 1) {
    const base = index * 3;
    await waitForRequests(state, base + 1);
    assert.equal(state.requests[base].url, '/api/submit-file?action=init');
    assert.equal(JSON.parse(state.requests[base].options.body).original_filename, files[index].name);
    state.requests[base].resolve({ ok: true, status: 201, json: async () => ({ ok: true, upload_token: `token-${index}` }) });
    await waitForRequests(state, base + 2);
    state.requests[base + 1].resolve({ ok: true, status: 200, json: async () => ({ ok: true }) });
    await waitForRequests(state, base + 3);
    state.requests[base + 2].resolve({ ok: true, status: 201, json: async () => ({
      ok: true, student_id: 'IMAGE001', original_filename: files[index].name, submitted_at: '2026-10-05T03:04:00.000Z'
    }) });
  }
  await upload;

  assert.equal(state.requests.length, 9);
  assert.match(elements.submissionStatus.textContent, /3件の課題ファイルを提出しました/u);
  assert.match(elements.submissionStatus.textContent, /写真\.jpg、図\.png、記録\.heic/u);
  assert.equal(elements.assignmentFile.files.length, 0);
});

test('standalone submission uploads sequentially, reports success, and allows resubmission', async () => {
  const state = page();
  const elements = state.elements;
  elements.studentId.value = '  TEST001  ';
  elements.studentId.events.input();
  elements.assignmentFile.files = [assignment('課題.pdf', 'application/pdf', 5)];
  elements.assignmentFile.events.change();

  const upload = state.submit();
  assert.equal(elements.submitAssignment.disabled, true);
  assert.equal(state.requests[0].url, '/api/submit-file?action=init');
  assert.deepEqual(JSON.parse(state.requests[0].options.body), {
    student_id: 'TEST001', original_filename: '課題.pdf', content_type: 'application/pdf', file_size: 5
  });
  state.requests[0].resolve({ ok: true, status: 201, json: async () => ({ ok: true, upload_token: 'signed-token' }) });
  await waitForRequests(state, 2);
  assert.equal(state.requests[1].url, '/api/submit-file?action=chunk');
  assert.equal(state.requests[1].options.headers['X-Chunk-Number'], '1');
  state.requests[1].resolve({ ok: true, status: 200, json: async () => ({ ok: true }) });
  await waitForRequests(state, 3);
  assert.equal(state.requests[2].url, '/api/submit-file?action=complete');
  state.requests[2].resolve({ ok: true, status: 201, json: async () => ({
    ok: true, student_id: 'TEST001', original_filename: '課題.pdf', submitted_at: '2026-10-05T03:04:00.000Z'
  }) });
  await upload;

  assert.match(elements.submissionStatus.textContent, /課題ファイルを提出しました/u);
  assert.match(elements.submissionStatus.textContent, /TEST001/u);
  assert.match(elements.submissionStatus.textContent, /課題\.pdf/u);
  assert.equal(elements.assignmentFile.files.length, 0);

  elements.assignmentFile.files = [assignment('再提出.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 3)];
  elements.assignmentFile.events.change();
  assert.equal(elements.submitAssignment.disabled, false);
});

test('standalone submission failure never reports success and requests cleanup', async () => {
  const state = page();
  const elements = state.elements;
  elements.studentId.value = 'TEST002';
  elements.studentId.events.input();
  const file = assignment('課題.pdf', 'application/pdf', 5);
  elements.assignmentFile.files = [file];
  elements.assignmentFile.events.change();

  const upload = state.submit();
  state.requests[0].resolve({ ok: true, status: 201, json: async () => ({ ok: true, upload_token: 'signed-token' }) });
  await waitForRequests(state, 2);
  state.requests[1].resolve({ ok: false, status: 502, json: async () => ({ code: 'UPLOAD_FAILED' }) });
  await upload;

  assert.match(elements.submissionStatus.textContent, /提出できませんでした/u);
  assert.doesNotMatch(elements.submissionStatus.textContent, /提出しました/u);
  assert.equal(elements.assignmentFile.files[0], file);
  await waitForRequests(state, 3);
  assert.equal(state.requests[2].url, '/api/submit-file?action=abort');
});
