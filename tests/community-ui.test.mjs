import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source = readFileSync(new URL('../community.js', import.meta.url), 'utf8');

function screen(caseId = 'A', clipboard) {
  const elements = {};
  const make = () => ({
    value: '', textContent: '', className: '', disabled: false, hidden: true, children: [], events: {},
    addEventListener(name, fn) { this.events[name] = fn; },
    appendChild(node) { this.children.push(node); }, replaceChildren() { this.children = []; }, focus() {},
    select() { this.selected = true; }, setSelectionRange(start, end) { this.selection = [start, end]; },
    requestSubmit() { return this.events.submit({ preventDefault() {} }); }
  });
  for (const id of ['chat','chatForm','userInput','target','send','reset','status','copyLog','copyStatus','manualCopy','logText','selectLog']) elements[id] = make();
  elements.target.value = 'auto';
  const requests = [];
  const intervals = new Map();
  const copied = [];
  let time = 1000, timer = 0, confirms = true;
  vm.runInNewContext(source, {
    document: { body: { dataset: {case:caseId} }, getElementById: id => elements[id], createElement: make },
    window: { confirm: () => confirms }, AbortController, TypeError,
    navigator: { clipboard: clipboard === null ? undefined : clipboard || { writeText: async text => { copied.push(text); } } },
    Date: { now: () => time },
    setTimeout: () => ++timer, clearTimeout() {},
    setInterval: fn => { intervals.set(++timer,fn); return timer; }, clearInterval: id => intervals.delete(id),
    fetch: (url, options) => new Promise((resolve,reject) => requests.push({url,options,resolve,reject}))
  });
  return {
    elements, requests, copied,
    copy: () => elements.copyLog.events.click(),
    submit: () => elements.chatForm.requestSubmit(),
    reset: () => elements.reset.events.click(),
    confirm: value => { confirms=value; },
    advance: ms => {time+=ms; for (const fn of intervals.values()) fn();},
    reply: (index, status=200, body={reply:'和子「こんにちは」',userMessage:'質問'}) => {
      requests[index].resolve({ok:status===200,status,json:async()=>body});
    }
  };
}
test('double submit sends once; all successful turns are retained; errors are retryable without duplicate history', async () => {
  const s=screen(), e=s.elements;
  e.userInput.value='質問';
  const first=s.submit(); await s.submit();
  assert.equal(s.requests.length,1); assert.equal(e.send.disabled,true); assert.equal(e.userInput.disabled,true);
  s.reply(0); await first;
  assert.equal(e.chat.children.length,2); assert.equal(e.userInput.value,'');
  e.userInput.value='次の質問';
  const second=s.submit();
  assert.equal(JSON.parse(s.requests[1].options.body).history.length,2);
  s.reply(1,502,{error:'通信エラー'}); await second;
  assert.equal(e.userInput.value,'次の質問'); assert.equal(e.chat.children.length,2);
  const retry=s.submit();
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

async function complete(s, question, reply, target = 'auto') {
  s.elements.userInput.value = question;
  s.elements.target.value = target;
  const send = s.submit();
  const names = { kazuko:'和子さん', kenta:'健太さん', both:'お二人' };
  s.reply(s.requests.length - 1, 200, { reply, userMessage: names[target] ? `【質問先：${names[target]}】\n${question}` : question });
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
  assert.equal(s.copied[0], '地域包括ケア演習 事例A\n精神疾患のある息子と暮らす高齢女性の地域生活\n\n【会話ログ】\n学生（和子さんへ）：\n普段は？\n\n和子：\n花の世話をしています。\n\n学生（健太さんへ）：\n好きなことは？\n\n健太：\n写真です。\n\n学生（お二人へ）：\nこれからは？\n\n和子：\nここで暮らしたいです。\n\n健太：\n僕もです。');
  assert.equal(s.elements.copyStatus.textContent,'会話ログをコピーしました．Moodleの提出欄に貼り付けてください．');
  assert.equal(s.elements.chat.children.length,6);
  await complete(s,'自動の質問','和子「はい。」');await s.copy();
  assert.match(s.copied[1],/学生：\n自動の質問\n\n和子：\nはい。$/);
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
  assert.equal(s.copied[1],'地域包括ケア演習 事例B\n免許返納をきっかけに生活が変化した独居高齢男性の地域生活\n\n【会話ログ】\n学生：\n昔の仕事は？\n教えてください。\n\n正夫：\n建設の仕事や。');
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
