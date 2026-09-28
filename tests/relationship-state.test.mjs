import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateRelationship, relationshipInstruction } from '../api/relationship-state.mjs';

function add(history, message, reply = '対象者「返答」') {
  return [...history, { role: 'user', content: message }, { role: 'assistant', content: reply }];
}

test('case B stays guarded until an explicit apology and recovers according to repeated offenses', () => {
  let history = [];
  let result = evaluateRelationship('B', history, 'なんで免許返納したの？');
  assert.equal(result.state, 'guarded');

  history = add(history, 'なんで免許返納したの？');
  result = evaluateRelationship('B', history, '心配だったの？');
  assert.equal(result.state, 'guarded');
  assert.equal(result.offenseCount, 2);

  history = add(history, '心配だったの？');
  result = evaluateRelationship('B', history, '病院にはどのように行かれていますか？');
  assert.equal(result.state, 'guarded');

  history = add(history, '病院にはどのように行かれていますか？');
  result = evaluateRelationship('B', history, '先ほどは失礼しました．言い方がよくありませんでした');
  assert.equal(result.state, 'recovering');
  assert.equal(result.recoveryNeeded, 3);

  history = add(history, '先ほどは失礼しました．言い方がよくありませんでした');
  result = evaluateRelationship('B', history, '通院について教えていただけますか？');
  assert.equal(result.state, 'recovering');
  history = add(history, '通院について教えていただけますか？');
  result = evaluateRelationship('B', history, '買い物はどのようにされていますか？');
  assert.equal(result.state, 'recovering');
  history = add(history, '買い物はどのようにされていますか？');
  result = evaluateRelationship('B', history, '畑では何を育てていらっしゃいますか？');
  assert.equal(result.state, 'neutral');
});

test('case B recovers quickly after one offense and reset starts neutral', () => {
  let history = add([], 'ちゃんと薬飲んでる？');
  let result = evaluateRelationship('B', history, '申し訳ありませんでした．服薬について伺ってもよいですか？');
  assert.equal(result.state, 'recovering');
  history = add(history, '申し訳ありませんでした．服薬について伺ってもよいですか？');
  result = evaluateRelationship('B', history, '普段はどの時間に飲まれていますか？');
  assert.equal(result.state, 'neutral');
  assert.equal(evaluateRelationship('B', [], '病院にはどのように行かれていますか？').state, 'neutral');
});

test('case B recognizes the specified disrespect patterns without treating every plain form as rude', () => {
  for (const message of [
    'なんで免許返納したの？',
    '心配だったの？',
    'ちゃんと薬飲んでる？',
    '娘さんに頼めばいいやん',
    'もう85歳なんだから',
    '一人暮らしは無理ですよ',
    '畑はやめた方がいい'
  ]) assert.equal(evaluateRelationship('B', [], message).state, 'guarded', message);
  assert.equal(evaluateRelationship('B', [], '免許返納した理由は？').state, 'neutral');
});

test('case A treats one mild misstep as transient and accepts an immediate repair', () => {
  let history = [];
  let result = evaluateRelationship('A', history, '健太くんはお母さんに甘えているんですね', 'kenta');
  assert.equal(result.state, 'neutral');
  assert.equal(result.current.offense, true);
  assert.match(relationshipInstruction('A', result), /短く違和感や不快感/);

  history = add(history, '【質問先：健太さん】\n健太くんはお母さんに甘えているんですね');
  result = evaluateRelationship('A', history, '失礼しました．健太さんご自身でできることを教えてください', 'kenta');
  assert.equal(result.state, 'neutral');
  assert.equal(result.current.apology, true);
  assert.match(relationshipInstruction('A', result), /通常に近い回答/);
});

test('case A repeated disrespect becomes guarded and clears gradually after repair', () => {
  let history = add([], '【質問先：健太さん】\n健太くんは普段何をしているの？');
  let result = evaluateRelationship('A', history, '統合失調症だから仕事は無理ですよね', 'kenta');
  assert.equal(result.state, 'guarded');

  history = add(history, '【質問先：健太さん】\n統合失調症だから仕事は無理ですよね');
  result = evaluateRelationship('A', history, '普段はどのように過ごされていますか？', 'kenta');
  assert.equal(result.state, 'guarded');

  history = add(history, '【質問先：健太さん】\n普段はどのように過ごされていますか？');
  result = evaluateRelationship('A', history, '失礼しました．決めつけた聞き方でした．できることから教えていただけますか？', 'kenta');
  assert.equal(result.state, 'recovering');

  history = add(history, '【質問先：健太さん】\n失礼しました．決めつけた聞き方でした．できることから教えていただけますか？');
  result = evaluateRelationship('A', history, '写真について教えていただけますか？', 'kenta');
  assert.equal(result.state, 'neutral');
});

test('case A clear discriminatory assumptions immediately become guarded', () => {
  const result = evaluateRelationship('A', [], '統合失調症だから危険で，入院が必要ですよね', 'kenta');
  assert.equal(result.state, 'guarded');
  assert.equal(result.current.severe, true);
});

test('case A repeated overly complex questions to Kenta become guarded and rephrasing starts recovery', () => {
  const complex = '今の生活について，朝から夜まで何をして，その理由は何で，お母さんとはどんな話をして，これから何をしたいですか？それから通院についてどう考えていますか？';
  let history = add([], `【質問先：健太さん】\n${complex}`);
  let result = evaluateRelationship('A', history, complex, 'kenta');
  assert.equal(result.state, 'guarded');
  history = add(history, `【質問先：健太さん】\n${complex}`);
  result = evaluateRelationship('A', history, '質問を言い換えます．普段好きなことを一つ教えていただけますか？', 'kenta');
  assert.equal(result.state, 'recovering');
});
