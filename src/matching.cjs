'use strict';
const { normalize, similarity, subjectNames, genericTitle } = require('./model.cjs');

const MIN_CONFIDENCE = 0.88;
const IMPORT_MIN_CONFIDENCE = 0.85;
const POPULAR_SUBTITLE_COLLECTIONS = 1000;
function subtitleBlocked(name) {
  const value = String(name || '').normalize('NFKC');
  return (
    installment(value).number !== null ||
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
function evidence(queries, explicit, subject) {
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
      const score =
        exactBase && candidate.number !== null ? 0.94 : similarity(query.name, candidate.name);
      item.match = Math.max(item.match, score);
    }
  }
  return item;
}
// Confidence and category admission happen before popularity or chronology.
// Only a shared exact base with a credible numbered member proves a series;
// broad substrings and cross-media names never share a chronology group.
function titleAgreement(subject, titleGroups, queryHits) {
  const names = subjectNames(subject).map(normalize);
  const primary = [subject.name, subject.name_cn].filter(Boolean).map(normalize);
  let agreement = 0,
    primaryParts = 0;
  for (const group of titleGroups) {
    if (names.includes(normalize(group.whole))) {
      agreement += 2;
      continue;
    }
    if (
      !group.parts.every(
        (part) =>
          names.includes(normalize(part)) &&
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
  { complete = true, titleGroups = [], queryHits } = {}
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
      ...evidence(queries, explicit, subject),
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
  let chosen = credible[0];
  if (chosen) {
    const rival = credible[1];
    if (titleGroups.length) {
      // Popularity and dates cannot settle conflicting bilingual identities.
      if (
        rival &&
        chosen.agreement === rival.agreement &&
        chosen.primaryParts === rival.primaryParts
      )
        chosen = null;
    } else {
      const numbered = new Set(credible.flatMap((item) => [...item.numberedSeries]));
      const keys = [...chosen.series].filter((key) => numbered.has(key));
      const family = credible.filter((item) => keys.some((key) => item.series.has(key)));
      if (family.length > 1) {
        family.sort(
          (a, b) =>
            a.date - b.date || b.match - a.match || b.total - a.total || a.subject.id - b.subject.id
        );
        chosen = family[0];
      } else if (chosen.match < 1 && credible[1] && chosen.match - credible[1].match < 0.06) {
        chosen = null;
      }
    }
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
  { complete = true, titleGroups = [], queryHits } = {}
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
      ...evidence(queries, explicit, subject),
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
  const highest = eligible.reduce((best, item) => Math.max(best, item.match), 0);
  const close = eligible.filter((item) => highest - item.match <= 0.03 + Number.EPSILON * 4);
  const maxTotal = close.reduce((best, item) => Math.max(best, item.total), 0);
  const popular = maxTotal > 0 ? close.filter((item) => item.total >= maxTotal * 0.9) : close;
  popular.sort(
    (a, b) =>
      a.date - b.date || b.total - a.total || b.match - a.match || a.subject.id - b.subject.id
  );
  const chosen = popular[0] || null;
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
