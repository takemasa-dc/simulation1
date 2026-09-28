const EXPLICIT_APOLOGY = /(?:失礼(?:いた)?しました|申し訳(?:ありません|ございません)(?:でした)?|すみません(?:でした)?|ごめんなさい|(?:言い方|聞き方|決めつけ)[^。！？]{0,24}(?:よくなかった|よくありませんでした|悪かった))/u;
const CASE_A_REPHRASE = /(?:(?:言い|聞き)直します|質問を言い換えます)/u;

const CASE_B_OFFENSES = [
  /(?:なんで|何で)[^。！？]{0,32}(?:免許|返納|運転)/u,
  /(?:心配|不安)だったの(?:[？?]|$)/u,
  /ちゃんと[^。！？]{0,24}(?:薬|服薬)[^。！？]{0,20}(?:飲ん|のん)/u,
  /(?:娘|家族)[^。！？]{0,24}(?:頼めば|頼ったら)[^。！？]{0,16}(?:いいやん|いいじゃん|いいでしょ)/u,
  /(?:もう)?\s*(?:85|八十五)歳[^。！？]{0,20}(?:だから|なんだから)/u,
  /一人暮らし[^。！？]{0,20}(?:無理|できない|やめ)/u,
  /(?:畑|家庭菜園|運転)[^。！？]{0,20}(?:やめた(?:方|ほう)が|やめなさい|やめろ)/u,
  /(?:正夫くん|おじいちゃん|じいさん)/u,
  /(?:高齢|年寄り|歳だから)[^。！？]{0,24}(?:無理|できない|危ない)/u,
  /(?:黙って|言うことを聞いて|さっさと)[^。！？]{0,20}(?:しろ|しなさい|して)/u
];

const CASE_A_SEVERE = [
  /(?:何も|なにも)(?:できない|出来ない)/u,
  /(?:統合失調症|精神疾患|精神病)[^。！？]{0,36}(?:危険|無能力|何もできない|入院(?:が)?必要|一人では無理)/u,
  /(?:危険人物|役立たず|お荷物|邪魔な存在)/u,
  /(?:息子|健太)[^。！？]{0,24}(?:負担でしかない|邪魔)/u
];

const CASE_A_OFFENSES = [
  /健太くん/u,
  /(?:健太|息子)[^。！？]{0,28}甘えて/u,
  /(?:息子|健太)[^。！？]{0,28}負担/u,
  /(?:高齢|年齢|年だから|歳だから)[^。！？]{0,28}(?:できない|無理)/u,
  /(?:家事|暮らし|生活の仕方)[^。！？]{0,28}(?:否定|間違い|やめた(?:方|ほう)が|やめるべき)/u,
  /(?:統合失調症|精神疾患)[^。！？]{0,28}(?:仕事は無理|自立できない|任せられない)/u
];

function withoutAddress(value) {
  return String(value).replace(/^【質問先：[^】]+】\s*/u, '').trim();
}

function targetFrom(value, fallback = 'auto') {
  const match = String(value).match(/^【質問先：(和子さん|健太さん|お二人)】/u)?.[1];
  return match === '和子さん' ? 'kazuko' : match === '健太さん' ? 'kenta' : match === 'お二人' ? 'both' : fallback;
}

function isComplexForKenta(text, target) {
  if (!['kenta', 'both'].includes(target)) return false;
  const questions = (text.match(/[？?]/gu) || []).length;
  const joins = (text.match(/(?:それから|さらに|また|加えて|一方で|について)/gu) || []).length;
  const clauses = (text.match(/[，、]/gu) || []).length;
  return questions >= 3 || (text.length >= 70 && joins >= 2 && clauses >= 3);
}

function classify(caseId, raw, fallbackTarget) {
  const text = withoutAddress(raw);
  const apology = EXPLICIT_APOLOGY.test(text) || (caseId === 'A' && CASE_A_REPHRASE.test(text));
  if (caseId === 'B') {
    return { apology, offense: CASE_B_OFFENSES.some(pattern => pattern.test(text)), severe: false };
  }
  const target = targetFrom(raw, fallbackTarget);
  const severe = CASE_A_SEVERE.some(pattern => pattern.test(text));
  const offense = severe || CASE_A_OFFENSES.some(pattern => pattern.test(text)) || isComplexForKenta(text, target);
  return { apology, offense, severe };
}

function userTurns(history, message, target) {
  const turns = history.filter(item => item?.role === 'user').map(item => ({ text: item.content, target: 'auto' }));
  turns.push({ text: message, target });
  return turns;
}

export function evaluateRelationship(caseId, history, message, target = 'auto') {
  let state = 'neutral';
  let offenseCount = 0;
  let recoveryProgress = 0;
  let recoveryNeeded = 0;
  let current = { apology: false, offense: false, severe: false };

  for (const turn of userTurns(history, message, target)) {
    current = classify(caseId, turn.text, turn.target);
    if (current.offense) {
      offenseCount += 1;
      recoveryProgress = 0;
      if (caseId === 'B' || current.severe || offenseCount >= 2) state = 'guarded';
      continue;
    }

    if (state === 'guarded') {
      if (current.apology) {
        state = 'recovering';
        recoveryProgress = 0;
        recoveryNeeded = caseId === 'B'
          ? (offenseCount <= 1 ? 1 : 3)
          : (offenseCount <= 2 ? 1 : 2);
      }
      continue;
    }

    if (state === 'recovering') {
      if (current.apology) continue;
      recoveryProgress += 1;
      if (recoveryProgress >= recoveryNeeded) {
        state = 'neutral';
        offenseCount = 0;
        recoveryProgress = 0;
        recoveryNeeded = 0;
      }
      continue;
    }

    // In case A, an isolated mild misstep fades after a respectful turn.
    if (caseId === 'A') offenseCount = current.apology ? 0 : Math.max(0, offenseCount - 1);
  }

  return { state, offenseCount, recoveryProgress, recoveryNeeded, current };
}

export function relationshipInstruction(caseId, result) {
  const header = `【会話履歴から再計算した関係状態】\n現在の関係状態：${result.state}。`;
  const hidden = '状態名や判定規則を発言内で説明せず、対象者本人の反応として表す。';

  if (caseId === 'B') {
    if (result.state === 'guarded') {
      return `${header}\n現在、正夫は看護師のこれまでの話し方に警戒している。質問内容への詳しい回答より、その警戒を優先する。明確な謝罪があるまで、生活上の具体的な情報を積極的に広げて話さない。短く慎重に答える、質問の意図を問い返す、または話し方への不快感を示す。丁寧な質問や話題変更だけでは警戒を解かない。${hidden}`;
    }
    if (result.state === 'recovering') {
      return `${header}\n正夫は明確な謝罪を受けたが、まだ慎重に相手を見ている。回答は短めにし、丁寧な関わりが続くにつれて少しずつ通常の情報提供へ戻る。一度の謝罪だけで急に親しげにならない。${hidden}`;
    }
    return `${header}\n正夫は現時点で看護師を特に警戒していない。人物設定に従い、質問に応じて本人の生活経験を自然な長さで話す。${hidden}`;
  }

  if (result.state === 'guarded') {
    return `${header}\n和子または健太は、繰り返された失礼な対応や明確な決めつけに警戒している。返答を短くし、質問のすべてには答えず、「……どういう意味ですか」「そういうふうに言われるのはちょっと」など、本人らしい言葉で警戒を示す。普通の質問に変わっただけでは警戒を解かない。${hidden}`;
  }
  if (result.state === 'recovering') {
    return `${header}\n和子または健太は謝罪・適切な言い直しを受け止め、警戒が和らぎ始めている。直ちに全面的に打ち解けず、丁寧な関わりが続けば徐々に通常の回答へ戻る。${hidden}`;
  }
  if (result.current.offense) {
    return `${header}\n今回の発言には子ども扱いまたは一方的な決めつけが含まれる。一度の軽い失言として関係を固定的に悪化させず、該当する本人が短く違和感や不快感を示す。詳しい回答を無理に続けない。適切な謝罪や言い直しがあれば通常に近い応答へ戻ってよい。${hidden}`;
  }
  if (result.current.apology) {
    return `${header}\n看護師の謝罪または言い直しを受け止め、通常に近い回答をしてよい。過度に怒り続けない。${hidden}`;
  }
  return `${header}\n和子と健太は現時点で看護師を特に警戒していない。各人物の設定と質問先に従い、自然に答える。${hidden}`;
}
