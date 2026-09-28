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

test('case B does not return to neutral when clear casual speech continues after an apology', () => {
  let history = add([], 'なんで免許返納したの？');
  history = add(history, '先ほどは失礼しました．言い方がよくありませんでした');
  let result = evaluateRelationship('B', history, 'じゃあ病院にはどうやって行ってるの？');
  assert.equal(result.state, 'recovering');
  assert.equal(result.recoveryProgress, 0);
  assert.equal(result.current.casual, true);
  assert.match(relationshipInstruction('B', result), /回復につながる丁寧な関わりとは扱わない/);
  assert.match(relationshipInstruction('B', result), /質問された事実部分に答えず/);
  assert.match(relationshipInstruction('B', result), /新しい生活上の具体的情報も述べない/);

  history = add(history, 'じゃあ病院にはどうやって行ってるの？');
  result = evaluateRelationship('B', history, '病院にはどのように行かれていますか？');
  assert.equal(result.state, 'neutral');
});

test('case B returns to guarded when a clearly disrespectful form follows an apology', () => {
  let history = add([], 'なんで免許返納したの？');
  history = add(history, '申し訳ありませんでした');
  const result = evaluateRelationship('B', history, 'ちゃんと薬飲んでる？');
  assert.equal(result.state, 'guarded');
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
  assert.match(relationshipInstruction('A', result), /一文程度で違和感や不快感/);

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

test('A-1 and A-2: bare direct address is disrespectful but honorific address is not', () => {
  const bare = evaluateRelationship('A', [], '健太はどうなの？', 'kenta');
  assert.equal(bare.current.offense, true);
  assert.equal(bare.state, 'guarded');
  assert.deepEqual(bare.affected, ['kenta']);

  const honorific = evaluateRelationship('A', [], '健太さんはどうですか？', 'kenta');
  assert.equal(honorific.current.offense, false);
  assert.equal(honorific.state, 'neutral');
});

test('A-3 and A-4: Kazuko counts a bare reference as mild and denigration as severe', () => {
  const bareReference = evaluateRelationship('A', [], '健太は仕事してるの？', 'kazuko');
  assert.equal(bareReference.current.offense, true);
  assert.equal(bareReference.current.severe, false);
  assert.equal(bareReference.state, 'neutral');
  assert.deepEqual(bareReference.affected, ['kazuko']);

  const denigration = evaluateRelationship('A', [], '健太は怠けている？', 'kazuko');
  assert.equal(denigration.current.severe, true);
  assert.equal(denigration.state, 'guarded');
  assert.deepEqual(denigration.affected, ['kazuko']);
});

test('A-5 and A-6: ability denial and treating Kenta as an obstacle immediately guard affected people', () => {
  const abilityDenial = evaluateRelationship('A', [], 'どうして？仕事もできないのに？', 'kenta');
  assert.equal(abilityDenial.current.severe, true);
  assert.equal(abilityDenial.state, 'guarded');
  assert.deepEqual(abilityDenial.affected, ['kenta']);

  const obstacle = evaluateRelationship('A', [], 'でも健太さんは邪魔じゃないの？', 'both');
  assert.equal(obstacle.current.severe, true);
  assert.equal(obstacle.state, 'guarded');
  assert.deepEqual(obstacle.affected, ['kazuko', 'kenta']);
  const instruction = relationshipInstruction('A', obstacle);
  assert.match(instruction, /和子と健太の双方/);
  assert.match(instruction, /通常どおり詳しく答えることよりも、その不快感を自然に示すことを優先/);
  assert.match(instruction, /能力・病歴・家族関係を丁寧に説明して看護師を納得させようとしない/);
});

test('A-7: one ordinary casual question does not trigger case A', () => {
  for (const message of ['何か困ってる？', 'いつから痛いの？']) {
    const result = evaluateRelationship('A', [], message, 'kenta');
    assert.equal(result.current.offense, false, message);
    assert.equal(result.state, 'neutral', message);
  }
});

test('A-8 through A-10: repeated mild bare address guards, persists, then recovers after repair', () => {
  let history = add([], '【質問先：和子さん】\n健太は元気？');
  let result = evaluateRelationship('A', history, '健太はどう過ごしてる？', 'kazuko');
  assert.equal(result.state, 'guarded');
  assert.deepEqual(result.affected, ['kazuko']);

  history = add(history, '【質問先：和子さん】\n健太はどう過ごしてる？');
  result = evaluateRelationship('A', history, '普段の暮らしについて教えていただけますか？', 'kazuko');
  assert.equal(result.state, 'guarded');

  history = add(history, '【質問先：和子さん】\n普段の暮らしについて教えていただけますか？');
  result = evaluateRelationship('A', history, '失礼しました．健太さんの日頃の過ごし方を教えていただけますか？', 'kazuko');
  assert.equal(result.state, 'recovering');

  history = add(history, '【質問先：和子さん】\n失礼しました．健太さんの日頃の過ごし方を教えていただけますか？');
  result = evaluateRelationship('A', history, '和子さんご自身は普段どのように過ごされていますか？', 'kazuko');
  assert.equal(result.state, 'neutral');
  assert.deepEqual(result.affected, []);
});

test('case A keeps neutral employment and facility questions unflagged', () => {
  for (const message of [
    '仕事はしていないんですか？',
    '施設について考えたことはありますか？'
  ]) {
    const result = evaluateRelationship('A', [], message, 'kenta');
    assert.equal(result.current.offense, false, message);
    assert.equal(result.state, 'neutral', message);
  }
});
