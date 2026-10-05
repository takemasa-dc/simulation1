import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source = readFileSync(new URL('../community.js', import.meta.url), 'utf8');

function screen(caseId = 'A', clipboard, compact = false, storage = new Map()) {
  const elements = {};
  const make = () => ({
    value: '', textContent: '', className: '', disabled: false, hidden: true, children: [], events: {},
    addEventListener(name, fn) { this.events[name] = fn; },
    appendChild(node) { this.children.push(node); }, replaceChildren() { this.children = []; }, focus() { this.focused = true; },
    scrollIntoView(options) { this.scrolledIntoView = options; },
    select() { this.selected = true; }, setSelectionRange(start, end) { this.selection = [start, end]; },
    requestSubmit() { return this.events.submit({ preventDefault() {} }); }
  });
  for (const id of ['chat','chatForm','userInput','target','send','reset','status','copyLog','copyStatus','manualCopy','logText','selectLog','submitLogForm','studentId','submitLog','submitStatus','submitFileForm','assignmentFile','submitFile','fileUploadProgress','fileSubmitStatus','interviewProgress']) elements[id] = make();
  elements.assignmentFile.files = [];
  let fileInputValue = '';
  Object.defineProperty(elements.assignmentFile, 'value', {
    get() { return fileInputValue; },
    set(value) { fileInputValue = value; if (value === '') this.files = []; }
  });
  elements.target.value = caseId === 'A' ? 'kazuko' : 'auto';
  const requests = [];
  const intervals = new Map();
  const copied = [];
  let time = 1000, timer = 0, confirms = true;
  class MockDate extends Date { static now() { return time; } }
  vm.runInNewContext(source, {
    document: { body: { dataset: {case:caseId} }, getElementById: id => elements[id], createElement: make },
    window: { confirm: () => confirms, matchMedia: () => ({ matches: compact }) }, AbortController, TypeError,
    localStorage: {
      getItem: key => storage.has(key) ? storage.get(key) : null,
      setItem: (key, value) => storage.set(key, String(value))
    },
    navigator: { clipboard: clipboard === null ? undefined : clipboard || { writeText: async text => { copied.push(text); } } },
    Date: MockDate,
    setTimeout: () => ++timer, clearTimeout() {},
    setInterval: fn => { intervals.set(++timer,fn); return timer; }, clearInterval: id => intervals.delete(id),
    fetch: (url, options) => new Promise((resolve,reject) => requests.push({url,options,resolve,reject}))
  });
  return {
    elements, requests, copied, storage,
    copy: () => elements.copyLog.events.click(),
    submit: () => elements.chatForm.requestSubmit(),
    submitConversation: () => elements.submitLogForm.requestSubmit(),
    submitAssignment: () => elements.submitFileForm.requestSubmit(),
    reset: () => elements.reset.events.click(),
    confirm: value => { confirms=value; },
    advance: ms => {time+=ms; for (const fn of intervals.values()) fn();},
    reply: (index, status=200, body={reply:'和子「こんにちは」',userMessage:'質問'}) => {
      requests[index].resolve({ok:status>=200&&status<300,status,json:async()=>body});
    }
  };
}
test('double submit sends once; all successful turns are retained; errors are retryable without duplicate history', async () => {
  const s=screen(), e=s.elements;
  e.userInput.value='質問';
  const first=s.submit(); await s.submit();
  assert.equal(s.requests.length,1); assert.equal(e.send.disabled,true); assert.equal(e.userInput.disabled,true);
  assert.equal(s.storage.get('community_caseA_totalUsage'),'1');
  s.reply(0); await first;
  assert.equal(e.chat.children.length,2); assert.equal(e.userInput.value,'');
  e.userInput.value='次の質問';
  const second=s.submit();
  assert.equal(s.storage.get('community_caseA_totalUsage'),'2');
  assert.equal(JSON.parse(s.requests[1].options.body).history.length,2);
  s.reply(1,502,{error:'通信エラー'}); await second;
  assert.equal(e.userInput.value,'次の質問'); assert.equal(e.chat.children.length,2);
  const retry=s.submit();
  assert.equal(s.storage.get('community_caseA_totalUsage'),'3');
  assert.equal(JSON.parse(s.requests[2].options.body).history.length,2);
  s.reply(2); await retry;
  assert.equal(e.chat.children.length,4);
});
test('reset cancels pending request; late old response cannot enter new conversation', async () => {
  const s=screen(),e=s.elements;
  e.userInput.value='古い質問'; const old=s.submit();
  s.reset(); assert.equal(s.requests[0].options.signal.aborted,true);
  e.userInput.value='新しい質問'; const fresh=s.submit();
  s.reply(0); await old;
  assert.equal(e.chat.children.length,0); assert.equal(e.send.disabled,true);
  assert.equal(JSON.parse(s.requests[1].options.body).history.length,0);
  s.reply(1,200,{reply:'和子「新しい会話」',userMessage:'新しい質問'});await fresh;
  assert.equal(e.chat.children.length,2); assert.equal(e.chat.children[1].textContent,'和子「新しい会話」');
  s.confirm(false);s.reset();assert.equal(e.chat.children.length,2);
});
test('429 countdown blocks sends and survives reset; question stays available', async () => {
  const s=screen(),e=s.elements;e.userInput.value='質問'; const request=s.submit();
  s.reply(0,429,{retryAfter:30});await request;
  assert.equal(e.userInput.value,'質問');assert.equal(e.send.disabled,true);
  await s.submit();assert.equal(s.requests.length,1);
  s.reset();assert.equal(e.send.disabled,true);
  s.advance(31000);assert.equal(e.send.disabled,false);
});
test('IME Enter never sends; plain Enter is newline; Ctrl+Enter sends; tabs stay separate', async () => {
  const s=screen(),e=s.elements;let submits=0;e.chatForm.requestSubmit=()=>submits++;
  const event=extra=>({key:'Enter',preventDefault(){},...extra});
  e.userInput.events.keydown(event({isComposing:true,ctrlKey:true}));
  e.userInput.events.keydown(event({keyCode:229,ctrlKey:true}));
  e.userInput.events.keydown(event({}));assert.equal(submits,0);
  e.userInput.events.keydown(event({ctrlKey:true}));assert.equal(submits,1);
  const a=screen(),b=screen('B');a.elements.userInput.value='学生A';b.elements.userInput.value='学生B';
  const one=a.submit(),two=b.submit();a.reply(0);b.reply(0);await Promise.all([one,two]);
  assert.equal(JSON.parse(a.requests[0].options.body).message,'学生A');
  assert.equal(JSON.parse(b.requests[0].options.body).message,'学生B');
  a.reset();assert.equal(b.elements.chat.children.length,2);
});

async function complete(s, question, reply, target) {
  s.elements.userInput.value = question;
  if (target) s.elements.target.value = target;
  const selected = s.elements.target.value;
  const send = s.submit();
  const names = { kazuko:'和子さん', kenta:'健太さん', both:'お二人' };
  s.reply(s.requests.length - 1, 200, { reply, userMessage: names[selected] ? `【質問先：${names[selected]}】\n${question}` : question });
  await send;
}
test('A copies full ordered text with mother, son and all selected recipients, without changing API history', async () => {
  const s=screen();
  assert.equal(s.elements.copyLog.disabled,true);
  await s.copy();assert.equal(s.copied.length,0);
  await complete(s,'普段は？','和子「花の世話をしています。」','kazuko');
  await complete(s,'好きなことは？','健太「写真です。」','kenta');
  await complete(s,'これからは？','和子「ここで暮らしたいです。」\n健太「僕もです。」','both');
  await s.copy();
  assert.equal(s.copied[0], '地域包括ケア演習 事例A\n精神疾患のある息子と暮らす高齢女性の地域生活\n\n【会話ログ】\n看護師（和子さんへ）：\n普段は？\n\n和子：\n花の世話をしています。\n\n看護師（健太さんへ）：\n好きなことは？\n\n健太：\n写真です。\n\n看護師（お二人へ）：\nこれからは？\n\n和子：\nここで暮らしたいです。\n\n健太：\n僕もです。');
  assert.equal(s.elements.copyStatus.textContent,'会話ログをコピーしました．Moodleの提出欄に貼り付けてください．');
  assert.equal(s.elements.chat.children.length,6);
  await complete(s,'初期値の質問','和子「はい。」','kazuko');await s.copy();
  assert.match(s.copied[1],/看護師（和子さんへ）：\n初期値の質問\n\n和子：\nはい。$/);
  const sent=JSON.parse(s.requests[3].options.body);
  assert.equal(sent.history.length,6);
  assert.deepEqual(Object.keys(sent.history[0]),['role','content']);
  assert.equal(sent.history[0].content,'【質問先：和子さん】\n普段は？');
  assert.equal(s.requests.length,4); // Copying makes no network requests.
});
test('B copies Masao and multiline literal text; failed and pending questions never appear', async () => {
  const s=screen('B');
  await complete(s,'昔の仕事は？\n教えてください。','正夫「建設の仕事や。」');
  s.elements.userInput.value='失敗した質問';const failed=s.submit();
  await s.copy();assert.doesNotMatch(s.copied[0],/失敗/);
  s.reply(1,502,{error:'API error secret'});await failed;
  await s.copy();
  assert.equal(s.copied[1],'地域包括ケア演習 事例B\n免許返納をきっかけに生活が変化した独居高齢男性の地域生活\n\n【会話ログ】\n看護師：\n昔の仕事は？\n教えてください。\n\n正夫：\n建設の仕事や。');
  assert.doesNotMatch(s.copied[1],/API|secret|失敗/);
  assert.equal(s.elements.userInput.value,'失敗した質問');
  await complete(s,'<b>文字のまま</b>','正夫「そうや。」');await s.copy();
  assert.match(s.copied[2],/<b>文字のまま<\/b>/);
});
test('clipboard rejection and missing API expose selectable full log, refreshed after conversation and cleared on reset', async () => {
  for (const clipboard of [null,{writeText:async()=>{throw new Error('denied');}}]) {
    const s=screen('B',clipboard),e=s.elements;
    await complete(s,'質問1','正夫「回答1」');await s.copy();
    assert.equal(e.manualCopy.hidden,false);assert.match(e.logText.value,/回答1/);
    e.selectLog.events.click();assert.equal(e.logText.selected,true);assert.deepEqual(e.logText.selection,[0,e.logText.value.length]);
    await complete(s,'質問2','正夫「回答2」');assert.match(e.logText.value,/回答1[\s\S]*回答2/);
    s.reset();assert.equal(e.manualCopy.hidden,true);assert.equal(e.logText.value,'');assert.equal(e.copyLog.disabled,true);
    await s.copy();assert.equal(e.logText.value,'');
    await complete(s,'新しい質問','正夫「新しい回答」');await s.copy();
    assert.doesNotMatch(e.logText.value,/回答1|回答2/);assert.match(e.logText.value,/新しい回答/);
  }
});
test('copy completion after reset cannot restore stale log or notification', async () => {
  let rejectCopy;
  const s=screen('A',{writeText:()=>new Promise((_,reject)=>{rejectCopy=reject;})});
  await complete(s,'古い質問','和子「古い回答」');const pending=s.copy();
  s.reset();rejectCopy(new Error('denied'));await pending;
  assert.equal(s.elements.manualCopy.hidden,true);assert.equal(s.elements.logText.value,'');
  assert.match(s.elements.copyStatus.textContent,/まだ会話がありません/);
});
test('a reply arriving while copying does not alter the snapshot; next copy includes it', async () => {
  let resolveCopy;const texts=[];
  const s=screen('B',{writeText:text=>{texts.push(text);return new Promise(resolve=>{resolveCopy=resolve;});}});
  await complete(s,'質問1','正夫「回答1」');const copy=s.copy();
  await complete(s,'質問2','正夫「回答2」');resolveCopy();await copy;
  assert.doesNotMatch(texts[0],/回答2/);assert.match(s.elements.copyStatus.textContent,/もう一度/);
  const next=s.copy();resolveCopy();await next;assert.match(texts[1],/回答1[\s\S]*回答2/);
});
test('A defaults and resets to Kazuko; mobile success reveals the latest reply', async () => {
  const s=screen('A',undefined,true),e=s.elements;
  assert.equal(e.target.value,'kazuko');
  await complete(s,'こんにちは','和子「こんにちは。」');
  assert.equal(JSON.parse(s.requests[0].options.body).target,'kazuko');
  assert.equal(e.chat.children.at(-1).scrolledIntoView.behavior,'smooth');
  assert.equal(e.chat.children.at(-1).scrolledIntoView.block,'center');
  assert.equal(e.userInput.focused,undefined);
  s.reset();assert.equal(e.target.value,'kazuko');
});

test('meeting gauge reaches zero at 25, allows 26-27, and ends after the 28th reply while copy remains available', async () => {
  const s=screen('B'),e=s.elements;
  assert.equal(e.interviewProgress.value,100);
  for (let i=1;i<=24;i++) await complete(s,`質問${i}`,`正夫「回答${i}」`);
  assert.equal(e.interviewProgress.value,4);
  assert.equal(e.send.disabled,false);

  await complete(s,'質問25','正夫「回答25」');
  assert.equal(e.interviewProgress.value,0);
  assert.match(e.status.textContent,/予定していた面談時間/);
  assert.equal(e.send.disabled,false);

  await complete(s,'質問26','正夫「回答26」');
  assert.match(e.status.textContent,/面談終了の時間が近づいています/);
  assert.equal(e.send.disabled,false);
  await complete(s,'質問27','正夫「回答27」');
  assert.equal(e.send.disabled,false);

  await complete(s,'質問28','正夫「回答28」');
  assert.match(e.status.textContent,/面談は終了しました/);
  assert.equal(e.send.disabled,true);
  assert.equal(e.userInput.disabled,true);
  assert.equal(e.copyLog.disabled,false);
  e.userInput.value='質問29';await s.submit();
  assert.equal(s.requests.length,28);
  await s.copy();assert.match(s.copied[0],/回答28/);
  e.studentId.value='20260001';e.studentId.events.input();
  e.assignmentFile.files=[assignment('終了後.pdf','application/pdf',5)];e.assignmentFile.events.change();
  assert.equal(e.submitFile.disabled,false);
  const submission=s.submitConversation();
  assert.equal(s.requests.length,29);
  assert.equal(s.requests[28].url,'/api/submit-log');
  s.reply(28,201,{ok:true,submitted_at:'2026-10-05T03:04:00.000Z'});await submission;
  assert.match(e.submitStatus.textContent,/会話ログを提出しました/);
  assert.equal(e.copyLog.disabled,false);
});

test('reload and reset restart the meeting gauge but retain per-case cumulative usage', async () => {
  const storage=new Map();
  const first=screen('A',undefined,false,storage);
  await complete(first,'質問','和子「回答」');
  assert.equal(storage.get('community_caseA_totalUsage'),'1');
  assert.equal(first.elements.interviewProgress.value,96);

  const reloaded=screen('A',undefined,false,storage);
  assert.equal(reloaded.elements.interviewProgress.value,100);
  assert.equal(reloaded.elements.send.disabled,false);
  assert.equal(storage.get('community_caseA_totalUsage'),'1');

  first.reset();
  assert.equal(first.elements.interviewProgress.value,100);
  assert.equal(storage.get('community_caseA_totalUsage'),'1');

  const otherCase=screen('B',undefined,false,storage);
  assert.equal(otherCase.elements.send.disabled,false);
  await complete(otherCase,'質問','正夫「回答」');
  assert.equal(storage.get('community_caseA_totalUsage'),'1');
  assert.equal(storage.get('community_caseB_totalUsage'),'1');
});

test('the 40th cumulative request is allowed, then later requests stop across reloads without disabling copy', async () => {
  const storage=new Map([['community_caseA_totalUsage','39']]);
  const s=screen('A',undefined,false,storage),e=s.elements;
  await complete(s,'最後の質問','和子「最後の回答」');
  assert.equal(storage.get('community_caseA_totalUsage'),'40');
  assert.match(e.status.textContent,/この演習で利用できる上限に達しました/);
  assert.equal(e.send.disabled,true);
  assert.equal(e.userInput.disabled,true);
  assert.equal(e.copyLog.disabled,false);
  e.userInput.value='上限後';await s.submit();assert.equal(s.requests.length,1);

  const reloaded=screen('A',undefined,false,storage);
  assert.equal(reloaded.elements.send.disabled,true);
  assert.equal(reloaded.elements.userInput.disabled,true);
  assert.match(reloaded.elements.status.textContent,/この演習で利用できる上限に達しました/);
  assert.equal(reloaded.requests.length,0);

  const caseB=screen('B',undefined,false,storage);
  assert.equal(caseB.elements.send.disabled,false);
  assert.equal(caseB.elements.interviewProgress.value,100);
});

test('both case pages show the interview-time gauge and explain that it is not elapsed time', () => {
  for (const file of ['../caseA.html','../caseB.html']) {
    const html=readFileSync(new URL(file,import.meta.url),'utf8');
    assert.match(html,/id="interviewProgress"/);
    assert.match(html,/面談時間の目安は，質問回数に応じて減っていきます．実際の経過時間を計測しているものではありません．/);
    assert.match(html,/id="studentId"[^>]*maxlength="50"/u);
    assert.match(html,/id="submitLog"/u);
    assert.match(html,/id="assignmentFile"[^>]*accept="[^"]*\.pptx,[^"]*\.pdf/u);
    assert.match(html,/id="submitFile"/u);
    assert.doesNotMatch(html,/\d+\s*\/\s*25/u);
  }
});

function assignment(name, type, size) {
  return { name, type, size, slice(start, end) { return { name, start, end, size: end - start }; } };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

async function waitForRequests(screenState, count) {
  for (let attempt = 0; attempt < 20 && screenState.requests.length < count; attempt += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.ok(screenState.requests.length >= count, `expected ${count} requests, received ${screenState.requests.length}`);
}

test('assignment submission requires ID and file, validates type and 100MB limit before requests', async () => {
  const s=screen('A'),e=s.elements;
  await s.submitAssignment();
  assert.match(e.fileSubmitStatus.textContent,/学籍番号を入力/);
  e.studentId.value='20260001';e.studentId.events.input();
  await s.submitAssignment();
  assert.match(e.fileSubmitStatus.textContent,/課題ファイルを選択/);

  e.assignmentFile.files=[assignment('malware.exe','application/octet-stream',10)];e.assignmentFile.events.change();
  await s.submitAssignment();
  assert.match(e.fileSubmitStatus.textContent,/PowerPoint/);
  assert.equal(s.requests.length,0);

  e.assignmentFile.files=[assignment('large.pdf','application/pdf',100*1024*1024+1)];e.assignmentFile.events.change();
  await s.submitAssignment();
  assert.match(e.fileSubmitStatus.textContent,/100MB以下/);
  assert.equal(s.requests.length,0);
});

test('assignment upload sends chunks sequentially, shows success, allows repeat, and does not clear chat', async () => {
  const s=screen('A'),e=s.elements;
  await complete(s,'質問','和子「回答」','kazuko');
  e.studentId.value='  TEST001  ';e.studentId.events.input();
  e.assignmentFile.files=[assignment('課題.pdf','application/pdf',5)];e.assignmentFile.events.change();
  assert.equal(e.submitFile.disabled,false);

  const upload=s.submitAssignment();
  assert.equal(e.submitFile.disabled,true);
  let request=s.requests.at(-1);
  assert.equal(request.url,'/api/submit-file?action=init');
  assert.deepEqual(JSON.parse(request.options.body),{student_id:'TEST001',original_filename:'課題.pdf',content_type:'application/pdf',file_size:5});
  request.resolve({ok:true,status:201,json:async()=>({ok:true,upload_token:'signed-token',chunk_size:4*1024*1024})});
  await waitForRequests(s,3);

  request=s.requests.at(-1);
  assert.equal(request.url,'/api/submit-file?action=chunk');
  assert.equal(request.options.headers['X-Upload-Token'],'signed-token');
  assert.equal(request.options.headers['X-Chunk-Number'],'1');
  request.resolve({ok:true,status:200,json:async()=>({ok:true,chunk_number:1})});
  await waitForRequests(s,4);

  request=s.requests.at(-1);
  assert.equal(request.url,'/api/submit-file?action=complete');
  request.resolve({ok:true,status:201,json:async()=>({ok:true,student_id:'TEST001',original_filename:'課題.pdf',submitted_at:'2026-10-05T03:04:00.000Z'})});
  await upload;
  assert.match(e.fileSubmitStatus.textContent,/課題ファイルを提出しました/);
  assert.match(e.fileSubmitStatus.textContent,/TEST001/);
  assert.match(e.fileSubmitStatus.textContent,/課題\.pdf/);
  assert.equal(e.assignmentFile.files.length,0);
  assert.equal(e.chat.children.length,2);
  assert.equal(e.copyLog.disabled,false);

  e.assignmentFile.files=[assignment('再提出.pptx','application/vnd.openxmlformats-officedocument.presentationml.presentation',3)];e.assignmentFile.events.change();
  assert.equal(e.submitFile.disabled,false);
});

test('assignment failure never shows success and requests cleanup without clearing the selected file', async () => {
  const s=screen('B'),e=s.elements;
  e.studentId.value='TEST002';e.studentId.events.input();
  const file=assignment('資料.pdf','application/pdf',5);
  e.assignmentFile.files=[file];e.assignmentFile.events.change();
  const upload=s.submitAssignment();
  s.requests[0].resolve({ok:true,status:201,json:async()=>({ok:true,upload_token:'signed-token'})});
  await waitForRequests(s,2);
  s.requests[1].resolve({ok:false,status:502,json:async()=>({code:'UPLOAD_FAILED'})});
  await upload;
  assert.match(e.fileSubmitStatus.textContent,/提出できませんでした/);
  assert.doesNotMatch(e.fileSubmitStatus.textContent,/提出しました/);
  assert.equal(e.assignmentFile.files[0],file);
  await waitForRequests(s,3);
  assert.equal(s.requests.at(-1).url,'/api/submit-file?action=abort');
});

test('student ID and a conversation are required, and copy and submission use the identical log', async () => {
  const s=screen('A'),e=s.elements;
  await s.submitConversation();
  assert.equal(s.requests.length,0);
  assert.match(e.submitStatus.textContent,/学籍番号を入力/);

  e.studentId.value='  20260001  ';e.studentId.events.input();
  assert.equal(e.submitLog.disabled,true);
  await complete(s,'普段は？','和子「花の世話をしています。」','kazuko');
  assert.equal(e.submitLog.disabled,false);
  await s.copy();
  const submission=s.submitConversation();
  assert.equal(e.studentId.value,'20260001');
  assert.equal(e.submitLog.disabled,true);
  assert.equal(e.studentId.disabled,true);
  const request=s.requests.at(-1);
  assert.equal(request.url,'/api/submit-log');
  const body=JSON.parse(request.options.body);
  assert.equal(body.student_id,'20260001');
  assert.equal(body.conversation_log,s.copied[0]);
  request.resolve({ok:true,status:201,json:async()=>({ok:true,submitted_at:'2026-10-05T03:04:00.000Z'})});
  await submission;
  assert.match(e.submitStatus.textContent,/会話ログを提出しました/);
  assert.match(e.submitStatus.textContent,/提出日時：/);
  assert.equal(e.chat.children.length,2);
  assert.equal(e.copyLog.disabled,false);
});

test('submission prevents double clicks, allows repeat submissions, and failures keep both case logs', async () => {
  for (const [caseId,reply] of [['A','和子「回答」'],['B','正夫「回答」']]) {
    const s=screen(caseId),e=s.elements;
    await complete(s,'質問',reply,caseId==='A'?'kazuko':undefined);
    e.studentId.value='same-id';e.studentId.events.input();

    const first=s.submitConversation();await s.submitConversation();
    const firstRequest=s.requests.at(-1);
    assert.equal(s.requests.filter(request=>request.url==='/api/submit-log').length,1);
    firstRequest.resolve({ok:true,status:201,json:async()=>({ok:true,submitted_at:'2026-10-05T03:04:00.000Z'})});await first;

    const second=s.submitConversation();
    const secondRequest=s.requests.at(-1);
    assert.equal(s.requests.filter(request=>request.url==='/api/submit-log').length,2);
    secondRequest.resolve({ok:false,status:502,json:async()=>({error:'unavailable'})});await second;
    assert.match(e.submitStatus.textContent,/提出できませんでした/);
    assert.equal(e.chat.children.length,2);
    assert.equal(e.copyLog.disabled,false);
    assert.equal(e.submitLog.disabled,false);
  }
});
