'use strict';
const path = require('node:path');
const crypto = require('node:crypto');
const { guardedAliases } = require('./verified-title-aliases.cjs');
const IMAGE_EXT = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.gif',
  '.apng',
  '.bmp',
  '.tiff',
  '.tif',
  '.avif',
  '.heic',
  '.heif',
  '.ico',
  '.jfif',
  '.jpe'
]);
const VIDEO_EXT = new Set([
  '.mp4',
  '.m4v',
  '.webm',
  '.mov',
  '.mkv',
  '.avi',
  '.wmv',
  '.mpeg',
  '.mpg',
  '.3gp',
  '.ts',
  '.m2ts'
]);
const MEDIA_EXT = new Set([...IMAGE_EXT, ...VIDEO_EXT]);
const normalize = (s) =>
  String(s ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\p{S}\s_]/gu, '');
const idFor = (p) =>
  crypto.createHash('sha256').update(path.resolve(p).toLowerCase()).digest('hex').slice(0, 24);
const genericTitle = (s) =>
  /^(?:(?:full|全)?cg|screenshots?|wallpapers?|pictures?|images?|photos?|albums?|collection|source|newfolder|acg|anime|animation|manga|comics?|games?|movies?|三次元|二次元|动画|動畫|动漫|漫画|游戏|遊戲|图片|截图|壁纸|图集|相册|设定集|素材|合集|新建文件夹|新建資料夾|新しいフォルダー|スクリーンショット|cg集)(?:\d+)?$/i.test(
    normalize(s)
  );
function legacySearchPlan(name) {
  const noise =
    /^(?:\d{3,4}p?|[248]k|uhd|hdr\d*|\d+bit|blu[ -]?ray|web[ -]?(?:dl|rip)|png|jpe?g|webp|(?:full|全)?cg(?:集)?|(?:游戏)?(?:图片|截图|壁纸|图集)|screenshots?|wallpapers?|汉化(?:版|组)?|中文(?:版)?|完(?:整|全)版|备注|備註|说明|説明|notes?)$/i;
  const prepare = (s) => s.trim().replace(/\s+/g, ' ').slice(0, 160);
  const isNoise = (s) =>
    noise.test(s.replace(/[:：]\s*$/u, '')) ||
    s
      .split(/[\s,，;；+|/\\_]+/u)
      .filter(Boolean)
      .every((part) => noise.test(part) || genericTitle(part));
  const meaningful = (s) =>
    normalize(s).length >= 2 && /\p{L}/u.test(s) && !genericTitle(s) && !isNoise(s);
  const clean = (s) => {
    if (isNoise(s.trim())) return '';
    return prepare(
      s
        .replace(/\b(?:CG|screenshots?|wallpapers?)\b/gi, ' ')
        .replace(/(?:全CG|图片|截图|壁纸|图集|相册)(?=\s*$|[\s_\-])/gi, ' ')
        .replace(/(?:^|\s)(?:\d{3,4}p|[248]k|uhd|hdr\d*)(?=\s|$)/gi, ' ')
        .replace(/^[\s|/\\_—–-]+|[\s|/\\_—–-]+$/gu, '')
        .replace(/系列\s*$/u, '')
    );
  };

  // Bracket contents are notes until the primary lookup fails. Parse nesting
  // rather than using a regex that can leak an inner note into the main title.
  // An unclosed bracket conservatively consumes the remaining text as a note.
  const brackets = new Map([
    ['(', ')'],
    ['[', ']'],
    ['【', '】'],
    ['{', '}'],
    ['「', '」'],
    ['『', '』'],
    ['〈', '〉'],
    ['《', '》']
  ]);
  const closers = new Set(brackets.values());
  const input = String(name ?? '').normalize('NFKC');
  const root = { text: '', children: [] };
  const stack = [root];
  let position = 0;
  for (const char of input) {
    const current = stack[stack.length - 1];
    if (brackets.has(char)) {
      const note = { text: '', children: [], close: brackets.get(char), start: position };
      current.text += ' ';
      current.children.push(note);
      stack.push(note);
    } else if (closers.has(char)) {
      const index = stack.findLastIndex((node) => node.close === char);
      if (index > 0) {
        stack[index].end = position + char.length;
        stack.length = index;
      } else current.text += ' ';
    } else current.text += char;
    position += char.length;
  }
  // Parentheses embedded in a title are title text. Only edge annotations are
  // deferred; a bracket in the middle must not silently change the work name.
  const outside = (start, end) => {
    let text = '',
      cursor = start;
    for (const note of root.children) {
      const finish = note.end ?? input.length;
      if (note.start < start || finish > end) continue;
      text += input.slice(cursor, note.start) + ' ';
      cursor = finish;
    }
    return text + input.slice(cursor, end);
  };
  const parsedText = root.text;
  let cursor = 0;
  root.text = '';
  for (const note of root.children) {
    const end = note.end ?? input.length;
    root.text += input.slice(cursor, note.start);
    note.embedded =
      meaningful(clean(outside(0, note.start))) &&
      meaningful(clean(outside(end, input.length))) &&
      !isNoise(note.text);
    root.text += note.embedded ? input.slice(note.start, end) : ' ';
    cursor = end;
  }
  root.text += input.slice(cursor);
  if (!root.children.some((note) => note.embedded)) root.text = parsedText;

  const boundary = /\s*[|/\\_;；，,—–]\s*|\s+-\s+/u;
  const letters = (s) => (s.match(/\p{L}/gu) || []).length;
  const language = (s) => {
    const value = s.replace(/[\p{P}\p{S}\p{N}\s]/gu, '');
    if (/^\p{Script=Han}+$/u.test(value)) return 'han';
    if (/^\p{Script=Latin}+$/u.test(value)) return 'latin';
    if (
      /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(value) &&
      /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー々]+$/u.test(value)
    )
      return 'japanese';
    return '';
  };
  const seen = new Set();
  const planFor = (value) => {
    const complete = clean(value);
    const segments = complete.split(boundary).map(prepare);
    if (!meaningful(complete) || segments.every((part) => !meaningful(part)))
      return { terms: [], titleGroups: [] };
    let parts;
    const canPair = (pair, explicit) => {
      if (pair.some((part) => !meaningful(part))) return false;
      const languages = pair.map(language);
      if (!languages[0] || !languages[1] || languages[0] === languages[1]) return false;
      const keys = pair.map(normalize);
      if (keys[0].includes(keys[1]) || keys[1].includes(keys[0])) return false;
      if (explicit) return pair.every((part) => letters(part) >= 2);
      // Spaces alone are weaker evidence. Keep Japanese titles with Latin
      // words intact, and require long phrases for a Han/Japanese pair.
      const han = languages.indexOf('han');
      if (han < 0) return false;
      const other = pair[1 - han];
      const acronym = /^[A-Z]{2,6}$/.test(other);
      const numbers = pair.map((part) => part.normalize('NFKC').match(/\d+/g) || []);
      const sameNumbers =
        numbers[0].length > 0 && JSON.stringify(numbers[0]) === JSON.stringify(numbers[1]);
      return (
        (letters(pair[han]) >= (languages[1 - han] === 'japanese' ? 6 : 4) ||
          (languages[1 - han] === 'latin' &&
            letters(pair[han]) >= 2 &&
            !/^(?:剧场版|劇場版|动画|動畫|电影|電影|漫画|漫畫|游戏|遊戲|小说|小說|真人版|特别篇|特別篇|重制版|重製版|完全版|完整版|续作|續作|外传|外傳)\d*$/.test(
              keys[han]
            ) &&
            ((other.match(/\p{Script=Latin}+/gu) || []).length >= 2 || sameNumbers || acronym))) &&
        (letters(other) >= 4 || (languages[1 - han] === 'latin' && acronym && letters(other) >= 2))
      );
    };
    const explicitPairs = [...complete.matchAll(new RegExp(boundary.source, 'gu'))]
      .map((match) => [
        prepare(complete.slice(0, match.index)),
        prepare(complete.slice(match.index + match[0].length))
      ])
      .filter((pair) => canPair(pair, true));
    if (explicitPairs.length === 1) parts = explicitPairs[0];
    if (!parts) {
      const spaces = [...complete.matchAll(/\s+/gu)];
      const pairs = spaces
        .map((match) => [complete.slice(0, match.index), complete.slice(match.index).trim()])
        .filter((pair) => canPair(pair, false));
      if (pairs.length === 1) parts = pairs[0];
      if (!parts) {
        // Exactly one script transition may hint two complete names. Never
        // extract runs from interleaved text or split Han/hiragana grammar.
        // Long Han/katakana runs retain the reported undelimited CN/JP case;
        // short ordinary names such as 機動戦士ガンダム remain a single query.
        const han = '[\\p{Script=Han}\\p{N}々\\s:：\\-]';
        const latin = '[\\p{Script=Latin}\\p{N}\\s\\p{P}]';
        const kana = '[\\p{Script=Katakana}ー・\\p{N}\\s]';
        for (const [left, right, minimum] of [
          [han, latin, 2],
          [latin, han, 2],
          [han, kana, 6],
          [kana, han, 6]
        ]) {
          const joined = complete.match(new RegExp(`^(${left}+)(${right}+)$`, 'u'));
          if (
            joined &&
            letters(joined[1]) >= minimum &&
            letters(joined[2]) >= minimum &&
            canPair([joined[1].trim(), joined[2].trim()], false)
          ) {
            parts = [joined[1].trim(), joined[2].trim()];
            break;
          }
        }
      }
    }
    if (!parts) {
      // Preserve existing three-name folders when all complete phrases have
      // different scripts. Repeated Han/Latin runs in one title never qualify.
      const canTriple = (group) =>
        group.length === 3 &&
        group.every((part) => meaningful(part) && letters(part) >= 4 && !/^\p{N}+\s/u.test(part)) &&
        new Set(group.map(language).filter(Boolean)).size === 3;
      if (canTriple(segments)) parts = segments;
      else {
        const spaces = [...complete.matchAll(/\s+/gu)];
        const triples = [];
        for (let first = 0; first < spaces.length; first++) {
          for (let second = first + 1; second < spaces.length; second++) {
            const group = [
              complete.slice(0, spaces[first].index).trim(),
              complete.slice(spaces[first].index, spaces[second].index).trim(),
              complete.slice(spaces[second].index).trim()
            ];
            if (canTriple(group)) triples.push(group);
          }
        }
        if (triples.length === 1) parts = triples[0];
      }
    }
    const terms = [];
    for (const candidate of [complete, ...(parts || [])]) {
      const term = prepare(candidate);
      const key = normalize(term);
      if (seen.size >= 6 || seen.has(key)) continue;
      seen.add(key);
      terms.push(term);
    }
    return {
      terms,
      // Deduplication and the global query limit must never weaken identity.
      // A missing part requires reusable earlier evidence or manual selection.
      titleGroups: parts ? [{ whole: complete, parts }] : []
    };
  };
  const primary = planFor(root.text);
  const fallbacks = [];
  const notes = root.children.filter((note) => !note.embedded);
  for (let index = 0; index < notes.length && seen.size < 6; index++) {
    const note = notes[index];
    const value = note.text.replace(
      /^\s*(?:原名|英文名|日文名|别名|別名|original(?:\s+title)?|english(?:\s+title)?|japanese(?:\s+title)?|alias)\s*[:：]\s*/i,
      ''
    );
    const fallback = planFor(value);
    if (fallback.terms.length) fallbacks.push(fallback);
    notes.splice(index + 1, 0, ...note.children);
  }
  return { ...primary, fallbacks };
}
function searchPlan(name) {
  const cleaned = legacySearchPlan(name);
  if (!cleaned.terms.length && !cleaned.fallbacks.length) return cleaned;
  let original = String(name ?? '')
    .normalize('NFKC')
    .trim();
  const brackets = new Map([
    ['(', ')'],
    ['[', ']'],
    ['【', '】'],
    ['{', '}'],
    ['「', '」'],
    ['『', '』'],
    ['〈', '〉'],
    ['《', '》']
  ]);
  // Strip only trailing annotation blocks. Brackets inside the work's title
  // and legal words such as CG stay in the first, complete-name hypothesis.
  const stack = [],
    spans = [];
  for (let index = 0; index < original.length; index++) {
    const char = original[index];
    if (brackets.has(char)) stack.push({ start: index, close: brackets.get(char) });
    else if (stack.length && char === stack.at(-1).close) {
      const node = stack.pop();
      if (!stack.length) spans.push({ start: node.start, end: index + 1 });
    }
  }
  if (stack.length) spans.push({ start: stack[0].start, end: original.length });
  for (const span of spans.reverse())
    if (!original.slice(span.end).trim()) original = original.slice(0, span.start).trim();
  const series = /系列\s*$/u.test(original);
  original = original
    .replace(/系列\s*$/u, '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 160);
  if (!original || genericTitle(original) || normalize(original).length < 2) return cleaned;
  if (original === cleaned.terms[0]) return series ? { ...cleaned, series: true } : cleaned;
  const alternatives = cleaned.terms.length
    ? [{ terms: cleaned.terms, titleGroups: cleaned.titleGroups }, ...cleaned.fallbacks]
    : cleaned.fallbacks;
  const seen = new Set([normalize(original)]),
    fallbacks = [];
  for (const phase of alternatives) {
    const terms = phase.terms.filter((term) => {
      const key = normalize(term);
      if (seen.has(key) || seen.size >= 6) return false;
      seen.add(key);
      return true;
    });
    if (terms.length) fallbacks.push({ terms, titleGroups: phase.titleGroups });
  }
  return { terms: [original], titleGroups: [], fallbacks, ...(series ? { series: true } : {}) };
}
// A complete folder title is one hypothesis. Query its translated fragments
// only after the complete-title phase has produced no high-confidence result.
// Keep the original plan shape for callers that inspect its evidence groups.
function searchStages(planOrName) {
  const plan =
    typeof planOrName === 'object' && planOrName !== null ? planOrName : searchPlan(planOrName);
  const stages = [],
    queried = new Set(),
    intent = plan.series ? { series: true } : {};
  for (const phase of [plan, ...(plan.fallbacks || [])]) {
    if (!phase.terms?.length) continue;
    if (phase.terms.length > 1 && phase.titleGroups?.length) {
      stages.push({ terms: [phase.titleGroups[0].whole], titleGroups: [], ...intent });
    }
    const terms = [...phase.terms];
    // Reuse earlier query evidence through the cache when this hypothesis needs it.
    // Parts excluded by the unique-query budget remain excluded.
    for (const part of (phase.titleGroups || []).flatMap((group) => group.parts)) {
      const key = normalize(part);
      if (queried.has(key) && !terms.some((term) => normalize(term) === key)) terms.push(part);
    }
    stages.push({ terms, titleGroups: phase.titleGroups || [], ...intent });
    for (const term of terms) queried.add(normalize(term));
  }
  return stages;
}
function searchTerms(name) {
  return searchStages(name)[0]?.terms || [];
}
function subjectNames(subject) {
  const aliases = (subject.infobox || [])
    .filter((item) => /^(?:别名|別名|alias(?:es)?)$/i.test(item.key))
    .flatMap((item) => (Array.isArray(item.value) ? item.value : [item.value]))
    .map((value) => (typeof value === 'string' ? value : value?.v));
  return [
    ...new Set(
      [
        subject.name,
        subject.name_cn,
        ...guardedAliases(subject),
        ...(Array.isArray(subject.aliases) ? subject.aliases : []),
        ...aliases
      ]
        .filter((s) => typeof s === 'string' && s.trim().length > 1)
        .map((s) => s.trim().slice(0, 160))
    )
  ].slice(0, 24);
}
// Streaming reduction: one candidate survives, regardless of directory size.
function newestImage(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  const stamp = (n) => (Number.isFinite(n.mtime) ? n.mtime : 0);
  if (stamp(a) !== stamp(b)) return stamp(a) > stamp(b) ? a : b;
  const ka = a.sortkey || normalize(a.name),
    kb = b.sortkey || normalize(b.name);
  if (ka !== kb) return ka < kb ? a : b;
  return String(a.id) <= String(b.id) ? a : b;
}
function similarity(a, b) {
  a = normalize(a);
  b = normalize(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (Math.min(a.length, b.length) < 3) return 0;
  const grams = (s) => new Set(Array.from({ length: s.length - 1 }, (_, i) => s.slice(i, i + 2)));
  const x = grams(a),
    y = grams(b);
  let n = 0;
  for (const v of x) if (y.has(v)) n++;
  return (2 * n) / (x.size + y.size);
}
function scoreSubject(terms, subject) {
  return Math.max(
    0,
    ...terms.flatMap((t) => subjectNames(subject).map((name) => similarity(t, name)))
  );
}
function parseSubjectId(input) {
  if (/^\d+$/.test(String(input).trim())) return Number(input);
  const m = String(input)
    .trim()
    .match(/^https:\/\/(?:bgm\.tv|bangumi\.tv|chii\.in)\/subject\/(\d+)(?:[/?#].*)?$/i);
  if (!m)
    throw new Error('请输入 Bangumi 条目网址，例如 https://bgm.tv/subject/123，或纯数字 ID。');
  return Number(m[1]);
}
function thumbnailKey(node, size = 1024) {
  return crypto
    .createHash('sha256')
    .update(`${node.path}|${node.mtime}|${node.bytes}|thumb-v4|${size}`)
    .digest('hex');
}
module.exports = {
  IMAGE_EXT,
  VIDEO_EXT,
  MEDIA_EXT,
  normalize,
  idFor,
  searchPlan,
  searchStages,
  searchTerms,
  genericTitle,
  subjectNames,
  newestImage,
  similarity,
  scoreSubject,
  parseSubjectId,
  thumbnailKey
};
