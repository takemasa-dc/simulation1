import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source = readFileSync(new URL('../community.js', import.meta.url), 'utf8');

function screen(caseId = 'A') {
  const elements = {};
  const make = () => ({
    value: '', textContent: '', className: '', disabled: false, children: [], events: {},
    addEventListener(name, fn) { this.events[name] = fn; },
    appendChild(node) { this.children.push(node); }, replaceChildren() { this.children = []; }, focus() {},
    requestSubmit() { return this.events.submit({ preventDefault() {} }); }
  });
  for (const id of ['chat','chatForm','userInput','target','send','reset','status']) elements[id] = make();
  elements.target.value = 'auto';
  const requests = [];
  const intervals = new Map();
  let time = 1000, timer = 0, confirms = true;
  vm.runInNewContext(source, {
    document: { body: { dataset: {case:caseId} }, getElementById: id => elements[id], createElement: make },
    window: { confirm: () => confirms }, AbortController, TypeError,
    Date: { now: () => time },
    setTimeout: () => ++timer, clearTimeout() {},
    setInterval: fn => { intervals.set(++timer,fn); return timer; }, clearInterval: id => intervals.delete(id),
    fetch: (url, options) => new Promise((resolve,reject) => requests.push({url,options,resolve,reject}))
  });
  return {
    elements, requests,
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
