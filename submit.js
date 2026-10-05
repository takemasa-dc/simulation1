(() => {
  'use strict';

  const MAX_FILE_SIZE = 100 * 1024 * 1024;
  const FILE_CHUNK_SIZE = 4 * 1024 * 1024;
  const FILE_TYPES = new Set(['.pdf', '.pptx']);
  const form = document.getElementById('assignmentForm');
  const studentId = document.getElementById('studentId');
  const assignmentFile = document.getElementById('assignmentFile');
  const submit = document.getElementById('submitAssignment');
  const progress = document.getElementById('uploadProgress');
  const status = document.getElementById('submissionStatus');
  let submitting = false;

  function extension(filename) {
    const index = filename.lastIndexOf('.');
    return index >= 0 ? filename.slice(index).toLowerCase() : '';
  }

  function updateControls() {
    submit.disabled = submitting || !studentId.value.trim() || !assignmentFile.files?.length;
    studentId.disabled = submitting;
    assignmentFile.disabled = submitting;
    submit.textContent = submitting ? '提出しています…' : '課題を提出';
  }

  function formatSubmittedAt(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const pad = number => String(number).padStart(2, '0');
    return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  async function fileApi(action, { json, body, uploadToken, chunkNumber, timeoutMs = 30000 } = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const headers = {};
    if (json !== undefined) headers['Content-Type'] = 'application/json';
    if (body !== undefined) headers['Content-Type'] = 'application/octet-stream';
    if (uploadToken) headers['X-Upload-Token'] = uploadToken;
    if (chunkNumber) headers['X-Chunk-Number'] = String(chunkNumber);
    try {
      const response = await fetch(`/api/submit-file?action=${action}`, {
        method: 'POST',
        headers,
        body: json !== undefined ? JSON.stringify(json) : body,
        signal: controller.signal
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok !== true) {
        const error = new Error(data.error || 'file submission failed');
        error.code = data.code;
        throw error;
      }
      return data;
    } finally {
      clearTimeout(timeout);
    }
  }

  studentId.addEventListener('input', updateControls);
  assignmentFile.addEventListener('change', () => {
    status.textContent = '';
    status.className = '';
    updateControls();
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (submitting) return;

    const normalizedStudentId = studentId.value.trim();
    studentId.value = normalizedStudentId;
    const file = assignmentFile.files?.[0];
    if (!normalizedStudentId) {
      status.textContent = '学籍番号を入力してください．';
      status.className = 'error';
      updateControls();
      studentId.focus();
      return;
    }
    if (!file) {
      status.textContent = '提出する課題ファイルを選択してください．';
      status.className = 'error';
      updateControls();
      return;
    }
    if (!FILE_TYPES.has(extension(file.name))) {
      status.textContent = 'PowerPoint（.pptx）またはPDF（.pdf）を選択してください．';
      status.className = 'error';
      return;
    }
    if (file.size > MAX_FILE_SIZE) {
      status.textContent = 'ファイルサイズが大きすぎます．100MB以下のファイルを提出してください．';
      status.className = 'error';
      return;
    }
    if (file.size <= 0) {
      status.textContent = '空のファイルは提出できません．';
      status.className = 'error';
      return;
    }

    submitting = true;
    updateControls();
    progress.hidden = false;
    progress.value = 0;
    progress.textContent = '0%';
    status.textContent = '課題ファイルを提出しています… 0%';
    status.className = '';
    let uploadToken;
    try {
      const initialized = await fileApi('init', {
        json: {
          student_id: normalizedStudentId,
          original_filename: file.name,
          content_type: file.type || '',
          file_size: file.size
        }
      });
      uploadToken = initialized.upload_token;
      if (typeof uploadToken !== 'string' || !uploadToken) throw new Error('invalid upload session');

      const chunks = Math.ceil(file.size / FILE_CHUNK_SIZE);
      for (let index = 0; index < chunks; index += 1) {
        const start = index * FILE_CHUNK_SIZE;
        const end = Math.min(file.size, start + FILE_CHUNK_SIZE);
        await fileApi('chunk', {
          body: file.slice(start, end),
          uploadToken,
          chunkNumber: index + 1,
          timeoutMs: 60000
        });
        const percent = Math.round(end / file.size * 100);
        progress.value = percent;
        progress.textContent = `${percent}%`;
        status.textContent = `課題ファイルを提出しています… ${percent}%`;
      }

      const completed = await fileApi('complete', { json: { upload_token: uploadToken }, timeoutMs: 120000 });
      const displayTime = formatSubmittedAt(completed.submitted_at);
      status.textContent = `課題ファイルを提出しました． 学籍番号：${completed.student_id || normalizedStudentId} ファイル名：${completed.original_filename || file.name}${displayTime ? ` 提出日時：${displayTime}` : ''}`;
      assignmentFile.value = '';
      progress.hidden = true;
    } catch (error) {
      if (uploadToken) fileApi('abort', { json: { upload_token: uploadToken } }).catch(() => {});
      status.textContent = error.code === 'FILE_TOO_LARGE'
        ? 'ファイルサイズが大きすぎます．100MB以下のファイルを提出してください．'
        : '提出できませんでした．通信環境を確認して，再度お試しください．';
      status.className = 'error';
      progress.hidden = true;
    } finally {
      submitting = false;
      updateControls();
    }
  });

  updateControls();
})();
