'use strict';
const { normalize, similarity, subjectNames, genericTitle } = require('./model.cjs');

const MIN_CONFIDENCE = 0.88;
const IMPORT_MIN_CONFIDENCE = 0.85;
const POPULAR_SUBTITLE_COLLECTIONS = 1000;
function subtitleBlocked(name) {
  const value = String(name || '').normalize('NFKC');
  return (
    installment(value).number !== null ||
    /续作|續作|续篇|續篇|续章|續章|后传|後傳|后日谈|後日談|(?:续|續|続|完|凸)\s*$|\b(?:after\s*story|encore|sequel|fan\s*dis[ck])\b/i.test(
      value
    ) ||
    /(?:^|\s)(?:[ivxlc]{1,8}|\d{1,2})(?=\s|$)/i.test(value) ||
    /第\s*[一二三四五六七八九十\d]+\s*[季期部作章]|\b(?:season|part)\s*(?:\d+|[ivxlc]+|one|two|three|four|five|six|seven|eight|nine|ten)\b|\d+(?:st|nd|rd|th)\s*season|\b(?:first|second|third|fourth|fifth)\s*season|剧场版|劇場版|总集篇|総集編|外传|外傳|番外|特别篇|特別篇|\b(?:movie|film|ova|oad|special|sp|spin[\s-]*off)\b/i.test(
      value
    )
  );
}
function subtitleMatch(query, name) {
  if (query.number !== null || query.base.length < 4 || installment(name).number !== null)
    return false;
  const value = String(name).normalize('NFKC').trim();
  for (const boundary of value.matchAll(/[\s:：—–~〜()（）\-]+/gu)) {
    if (normalize(value.slice(0, boundary.index)) !== query.base) continue;
    const rest = value.slice(boundary.index + boundary[0].length).trim();
    if (!rest || !/\p{L}/u.test(rest)) continue;
    // Full title coverage at a real boundary, never a broad substring. A
    // numbered season/part or a marked spinoff needs its own title evidence.
    if (
      /第\s*[一二三四五六七八九十\d]+\s*[季期部作章]|\b(?:season|part)\s*\d+|\d+(?:st|nd|rd|th)\s*season|^(?:\d+|[ivxlc]+)(?:\b|\s)|剧场版|劇場版|总集篇|総集編|外传|外傳|番外|特别篇|特別篇|\b(?:movie|film|ova|oad|special|sp)\b/i.test(
        rest
      )
    )
      continue;
    return true;
  }
  return false;
}
// Short Chinese titles can be the full identity before an attached Latin
// name or a visibly delimited tagline. This is narrower than prefix matching:
// Han continuations and numbered/marked derivatives still need direct evidence.
function attachedTitleMatch(query, name) {
  const base = String(query.name).normalize('NFKC').trim();
  if (query.number !== null || !/^\p{Script=Han}{3,}$/u.test(base)) return false;
  const value = String(name).normalize('NFKC').trim();
  if (!value.startsWith(base)) return false;
  const rest = value.slice(base.length);
  if (subtitleBlocked(rest.trim())) return false;
  return /^[a-z]{3,}$/i.test(rest) || /^\s*[-—–~〜～]\s*\p{L}[\p{L}\p{P}\p{S}\s]*$/u.test(rest);
}
function installmentNumber(value) {
  if (/^\d+$/.test(value)) return Number(value);
  const cn = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (cn[value]) return cn[value];
  const chinese = value.match(/^([一二三四五六七八九])?十([一二三四五六七八九])?$/);
  if (chinese) return (cn[chinese[1]] || 1) * 10 + (cn[chinese[2]] || 0);
  const roman = value.toLowerCase();
  if (!/^(?:xc|xl|l?x{0,3})(?:ix|iv|v?i{0,3})$/.test(roman)) return NaN;
  const digits = { i: 1, v: 5, x: 10, l: 50, c: 100 };
  return [...roman].reduce((total, digit, index) => {
    const n = digits[digit];
    return total + (n < digits[roman[index + 1]] ? -n : n);
  }, 0);
}
function installment(title) {
  const s = String(title).normalize('NFKC').trim();
  // A bare suffix must start at a digit boundary: 2006 is not installment 06.
  // Roman numerals require whitespace and a canonical spelling.
  const headed = s.match(
    /^(.*?)((?<!\d)\d{1,2}|(?<=\p{Script=Han})[ivxlc]{1,8}|\s+[ivxlc]{1,8})\s*(?:[:：—–~-]\s*|\s+)(?=\p{L})(.+)$/iu
  );
  if (headed && normalize(headed[1]).length >= 2) {
    const number = installmentNumber(headed[2].trim());
    if (Number.isSafeInteger(number) && number > 0) return { base: normalize(headed[1]), number };
  }
  const m = s.match(
    /^(.*?)\s*(?:第\s*([一二三四五六七八九十]{1,3}|\d{1,2})\s*[季期部作章]|(?:season|part)\s*(\d{1,2})|(?<!\d)(\d{1,2})(?:st|nd|rd|th)\s*season|\s+([ivxlc]{1,8})|(?<!\d)(\d{1,2}))\s*$/i
  );
  if (!m || normalize(m[1]).length < 2) return { base: normalize(s), number: null };
  const number = installmentNumber(m[2] || m[3] || m[4] || m[5] || m[6]);
  return Number.isInteger(number) && number > 0
    ? { base: normalize(m[1]), number }
    : { base: normalize(s), number: null };
}
function collections(subject) {
  const c = subject.collection;
  if (!c || typeof c !== 'object') return 0;
  return ['wish', 'collect', 'doing', 'on_hold', 'dropped'].reduce((sum, key) => {
    const n = Number(c[key]);
    return sum + (Number.isFinite(n) && n > 0 ? n : 0);
  }, 0);
}
function dateValue(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return Infinity;
  const t = Date.parse(value + 'T00:00:00Z');
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === value ? t : Infinity;
}
function evidence(queries, explicit, subject, series = false) {
  const item = {
    subject,
    match: 0,
    series: new Set(),
    numberedSeries: new Set(),
    total: collections(subject),
    date: dateValue(subject.date),
    primaryExact: false,
    subtitle: false
  };
  const names = subjectNames(subject).map((name) => ({ name, ...installment(name) }));
  const subtitleAllowed = !names.some(({ name }) => subtitleBlocked(name));
  const seriesAllowed =
    series &&
    !names.some(({ name }) =>
      /外传|外傳|番外|剧场|劇場|电影|電影|\b(?:movie|film|ova|oad|special|spin[\s-]?off)\b/i.test(
        name
      )
    );
  if (!explicit.length) {
    const primary = [subject.name, subject.name_cn].filter((name) => typeof name === 'string');
    // An alias of the unnumbered base cannot hide a visible sequel identity.
    if (
      queries.some((query) =>
        primary.some((name) => {
          const full = normalize(name);
          if (full === query.base || !full.startsWith(query.base)) return false;
          const franchiseNumber =
            seriesAllowed &&
            names.some((candidate) => candidate.base === query.base && candidate.number !== null);
          if (subtitleBlocked(name) && !subtitleBlocked(query.name) && !franchiseNumber)
            return true;
          // An undelimited continuation in Han can be another work or sequel;
          // reserve the extension shortcut for the explicit script/tagline boundary.
          return (
            /^\p{Script=Han}{3,}$/u.test(query.name) &&
            /^\p{Script=Han}+$/u.test(name.trim()) &&
            !attachedTitleMatch(query, name) &&
            !franchiseNumber
          );
        })
      )
    )
      return item;
  }
  if (explicit.length) {
    let supported = false;
    for (const query of explicit) {
      for (const candidate of names) {
        if (query.base !== candidate.base) continue;
        if (candidate.number === query.number) supported = true;
        else if (candidate.number !== null) return item;
      }
    }
    // A broad bilingual alias cannot supply missing explicit installment evidence.
    if (!supported) return item;
  }
  for (const query of queries) {
    for (const candidate of names) {
      if (
        query.number !== null &&
        query.base === candidate.base &&
        query.number !== candidate.number
      )
        continue;
      if (
        normalize(query.name) === normalize(candidate.name) &&
        [subject.name, subject.name_cn].some(
          (name) => typeof name === 'string' && normalize(name) === normalize(query.name)
        )
      )
        item.primaryExact = true;
      if (subtitleAllowed && subtitleMatch(query, candidate.name)) item.subtitle = true;
      const exactBase = query.number === null && query.base === candidate.base;
      if (exactBase) {
        const key = `${subject.type}:${query.base}`;
        item.series.add(key);
        if (candidate.number !== null) item.numberedSeries.add(key);
      }
      const exactInstallment =
        query.number !== null && query.base === candidate.base && query.number === candidate.number;
      const score = exactInstallment
        ? Math.max(0.97, similarity(query.name, candidate.name))
        : exactBase && candidate.number !== null
          ? seriesAllowed
            ? 0.97
            : 0.84
          : similarity(query.name, candidate.name);
      item.match = Math.max(
        item.match,
        score,
        subtitleAllowed && attachedTitleMatch(query, candidate.name) ? 0.97 : 0
      );
    }
  }
  return item;
}
function newestFirst(a, b) {
  if (Number.isFinite(a.date) !== Number.isFinite(b.date)) return Number.isFinite(a.date) ? -1 : 1;
  return Number.isFinite(a.date) ? b.date - a.date : 0;
}
function chooseClose(items) {
  const highest = Math.max(...items.map((item) => item.match));
  const close = items.filter((item) => highest - item.match <= 0.03 + 1e-12);
  const maxCollections = Math.max(...close.map((item) => item.total));
  const popular = close.filter((item) => item.total >= maxCollections * 0.9);
  return popular.sort(
    (a, b) =>
      newestFirst(a, b) || b.total - a.total || b.match - a.match || a.subject.id - b.subject.id
  )[0];
}
// Confidence, complete title identity and category admission precede popularity
// and chronology. Neither a subtitle nor a sequel may erase explicit evidence.
function titleAgreement(subject, titleGroups, queryHits) {
  if (!titleGroups.length) return { agreement: 0, primaryParts: 0 };
  const titles = subjectNames(subject);
  const names = titles.map(normalize);
  const numbered = titles.map(installment);
  const primary = [subject.name, subject.name_cn].filter(Boolean).map(normalize);
  let agreement = 0,
    primaryParts = 0;
  for (const group of titleGroups) {
    if (names.includes(normalize(group.whole))) {
      agreement += 2;
      continue;
    }
    // A retrieved exact numbered translation can verify the other language's full base.
    const verifiedNumbers = new Set(
      group.parts
        .filter(
          (part) =>
            names.includes(normalize(part)) &&
            (!queryHits || queryHits.get(subject.id)?.has(normalize(part)))
        )
        .map(installment)
        .map((part) => part.number)
        .filter((number) => number !== null)
    );
    const numberedTranslation = (part) => {
      const query = installment(part);
      if (query.number !== null || verifiedNumbers.size !== 1) return false;
      const number = [...verifiedNumbers][0];
      const family = numbered.filter((name) => name.base === query.base && name.number !== null);
      return (
        family.some((name) => name.number === number) &&
        family.every((name) => name.number === number)
      );
    };
    if (
      !group.parts.every(
        (part) =>
          (names.includes(normalize(part)) || numberedTranslation(part)) &&
          (!queryHits || queryHits.get(subject.id)?.has(normalize(part)))
      )
    )
      return { agreement: 0, primaryParts: 0 };
    agreement++;
    primaryParts += group.parts.filter((part) => primary.includes(normalize(part))).length;
  }
  return { agreement, primaryParts };
}
function rankSubjects(
  terms,
  subjects,
  types,
  { complete = true, titleGroups = [], queryHits, series = false } = {}
) {
  const queries = terms
    .filter((term) => !genericTitle(term))
    .map((name) => ({ name, ...installment(name) }));
  const explicit = queries.filter((query) => query.number !== null);
  const unique = new Map();
  for (const subject of subjects) {
    if (
      !subject ||
      !Number.isSafeInteger(subject.id) ||
      subject.id <= 0 ||
      !types.includes(subject.type)
    )
      continue;
    const item = {
      ...evidence(queries, explicit, subject, series),
      ...titleAgreement(subject, titleGroups, queryHits)
    };
    if (!unique.has(subject.id) || item.match > unique.get(subject.id).match)
      unique.set(subject.id, item);
  }
  const ranked = [...unique.values()].sort(
    (a, b) =>
      b.agreement - a.agreement ||
      b.primaryParts - a.primaryParts ||
      b.match - a.match ||
      Number(b.primaryExact) - Number(a.primaryExact) ||
      b.total - a.total ||
      a.subject.id - b.subject.id
  );
  const credible = ranked.filter(
    (item) => item.match >= MIN_CONFIDENCE && (!titleGroups.length || item.agreement > 0)
  );
  let eligible = complete ? credible : credible.filter((item) => item.match === 1);
  // A derivative's broad alias must not displace an exact official title.
  if (eligible.some((item) => item.match === 1 && item.primaryExact))
    eligible = eligible.filter((item) => item.match !== 1 || item.primaryExact);
  let chosen = chooseClose(eligible);
  if (titleGroups.length && credible.length) {
    // Popularity and dates cannot settle conflicting bilingual identities.
    const [best, rival] = credible;
    chosen =
      rival && best.agreement === rival.agreement && best.primaryParts === rival.primaryParts
        ? null
        : eligible.includes(best)
          ? best
          : null;
  }
  if (!chosen && complete && !explicit.length && !titleGroups.length && ranked.length === 1) {
    const only = ranked[0];
    if (only.subtitle && only.total >= POPULAR_SUBTITLE_COLLECTIONS) chosen = only;
  }
  const candidates = ranked.map((item) => ({
    ...item.subject,
    match: item.match,
    collection_total: item.total
  }));
  return {
    candidates: candidates.slice(0, 10),
    selected: chosen?.subject || null,
    selectedMatch: chosen?.match ?? null
  };
}

// Import has its own admission threshold and tie policy. Reuse the same identity
// evidence as normal matching, but decide over every admitted subject before the
// ten-row presentation limit. Complete recall compares exact and nearby fuzzy
// titles together; incomplete recall admits only verified exact titles.
function rankImportSubjects(
  terms,
  subjects,
  types,
  { complete = true, titleGroups = [], queryHits, series = false } = {}
) {
  const queries = terms
    .filter((term) => !genericTitle(term))
    .map((name) => ({ name, ...installment(name) }));
  const explicit = queries.filter((query) => query.number !== null);
  const unique = new Map();
  for (const subject of subjects) {
    if (
      !subject ||
      !Number.isSafeInteger(subject.id) ||
      subject.id <= 0 ||
      !types.includes(subject.type)
    )
      continue;
    const item = {
      ...evidence(queries, explicit, subject, series),
      ...titleAgreement(subject, titleGroups, queryHits)
    };
    // Individual counts are validated by collections(); an overflowing sum is
    // invalid too and must not win a popularity comparison.
    if (!Number.isFinite(item.total)) item.total = 0;
    if (!unique.has(subject.id) || item.match > unique.get(subject.id).match)
      unique.set(subject.id, item);
  }
  const ranked = [...unique.values()].sort(
    (a, b) =>
      b.agreement - a.agreement ||
      b.primaryParts - a.primaryParts ||
      b.match - a.match ||
      Number(b.primaryExact) - Number(a.primaryExact) ||
      b.total - a.total ||
      a.subject.id - b.subject.id
  );
  const admitted = ranked.filter(
    (item) => item.match > IMPORT_MIN_CONFIDENCE && (!titleGroups.length || item.agreement > 0)
  );
  // Restrict bounded recall before popularity is considered: an exact match
  // must never allow a nearby fuzzy candidate to bypass complete recall.
  const eligible = complete ? admitted : admitted.filter((item) => item.match === 1);
  const chosen = chooseClose(eligible) || null;
  // Keep the selected item visible even when chronology promoted an item that
  // appeared below the first ten rows in the evidence ordering.
  const visible = chosen
    ? [chosen, ...ranked.filter((item) => item.subject.id !== chosen.subject.id)]
    : ranked;
  const candidates = visible.slice(0, 10).map((item) => ({
    ...item.subject,
    match: item.match,
    collection_total: item.total
  }));
  return {
    candidates,
    selected: chosen?.subject || null,
    selectedMatch: chosen?.match ?? null,
    selectionReason:
      !complete && !chosen
        ? 'incomplete-recall'
        : !chosen
          ? 'no-eligible-candidate'
          : chosen.match === 1
            ? 'exact-popularity-date'
            : 'similarity-popularity-date'
  };
}

// Bounded promise cache coalesces repeated multilingual folder queries. Failed
// requests never become persistent misses, and categories are part of identity.
function createSearchCache({ limit = 128, ttl = 10 * 60 * 1000, now = Date.now } = {}) {
  const cache = new Map();
  return {
    get(query, types, load) {
      const key = `${[...types].sort((a, b) => a - b).join(',')}|${normalize(query)}`;
      const existing = cache.get(key);
      if (existing && now() - existing.at < ttl) return existing.value;
      if (existing) cache.delete(key);
      while (cache.size >= limit) cache.delete(cache.keys().next().value);
      const value = Promise.resolve().then(load);
      const item = { at: now(), value };
      cache.set(key, item);
      value.catch(() => {
        if (cache.get(key) === item) cache.delete(key);
      });
      return value;
    },
    clear: () => cache.clear(),
    get size() {
      return cache.size;
    }
  };
}
module.exports = {
  MIN_CONFIDENCE,
  IMPORT_MIN_CONFIDENCE,
  rankImportSubjects,
  installment,
  collections,
  dateValue,
  rankSubjects,
  createSearchCache
};
