'use strict';
const { normalize, similarity, subjectNames, genericTitle } = require('./model.cjs');
const { VERIFIED_ALIAS_VERSION } = require('./verified-title-aliases.cjs');

const MATCHING_POLICY_VERSION = '2026-11-02-known-title-series-v3';
const MIN_CONFIDENCE = 0.88;
const IMPORT_MIN_CONFIDENCE = 0.85;
const POPULAR_SUBTITLE_COLLECTIONS = 1000;
function seriesSideStory(name) {
  return /续篇|續篇|后传|後傳|后日谈|後日談|外传|外傳|番外|特别篇|特別篇|剧场|劇場|电影|電影|总集篇|総集編|\b(?:after\s*story|after|extra|encore|sequel|fan\s*dis[ck]|movie|film|ova|oad|special|sp|spin[\s-]*off)\b/i.test(
    String(name || '').normalize('NFKC')
  );
}
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
    exact: false,
    primaryExact: false,
    subtitle: false
  };
  const names = subjectNames(subject).map((name) => ({ name, ...installment(name) }));
  const subtitleAllowed = !names.some(({ name }) => subtitleBlocked(name));
  const seriesAllowed = series && !names.some(({ name }) => seriesSideStory(name));
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
      if (normalize(query.name) === normalize(candidate.name)) {
        item.exact = true;
        if (
          [subject.name, subject.name_cn].some(
            (name) => typeof name === 'string' && normalize(name) === normalize(query.name)
          )
        )
          item.primaryExact = true;
      }
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
function chooseEvidenceSeries(items, queries) {
  if (items.length < 2) return null;
  const common = [...items[0].series].filter((key) => items.every((item) => item.series.has(key)));
  let chosen = null;
  for (const key of common) {
    const query = queries.find((part) => `${items[0].subject.type}:${part.base}` === key);
    if (!query) return null;
    const subject = chooseSeriesSubject(
      items.map((item) => item.subject),
      {
        verified: true,
        query: query.name,
        base: key.slice(key.indexOf(':') + 1)
      }
    );
    if (!subject || (chosen && chosen.subject.id !== subject.id)) return null;
    chosen = items.find((item) => item.subject === subject);
  }
  return chosen;
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
  let eligible = complete ? credible : credible.filter((item) => item.exact);
  // A derivative's broad alias must not displace an exact official title.
  if (eligible.some((item) => item.exact && item.primaryExact))
    eligible = eligible.filter((item) => !item.exact || item.primaryExact);
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
  if (series && !titleGroups.length && eligible.length > 1)
    chosen = complete && !explicit.length ? chooseEvidenceSeries(eligible, queries) : null;
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
  const eligible = complete ? admitted : admitted.filter((item) => item.exact);
  let chosen = chooseClose(eligible) || null;
  if (titleGroups.length && eligible.length) {
    const [best, rival] = eligible;
    // Popularity/date cannot decide between two equally supported translations,
    // just as in explicit search. Complete alias proof must identify one work.
    chosen =
      rival && best.agreement === rival.agreement && best.primaryParts === rival.primaryParts
        ? null
        : best;
  }
  if (series && !titleGroups.length && eligible.length > 1)
    chosen = complete && !explicit.length ? chooseEvidenceSeries(eligible, queries) : null;
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
          : series && !titleGroups.length && eligible.length > 1
            ? 'series-representative'
            : chosen.exact
              ? 'exact-popularity-date'
              : 'similarity-popularity-date'
  };
}

// Reuse names from a bounded, caller-scoped metadata lookup before retrieval.
// No fuzzy score, popularity or date can establish a known identity. A short Han
// title may participate only when both complete names already belong to this ID.
function rankKnownSubjects(query, subjects, types) {
  const empty = (selectionReason) => ({
    candidates: [],
    selected: null,
    selectedMatch: null,
    selectionReason
  });
  if (
    typeof query !== 'string' ||
    query.length > 240 ||
    normalize(query).length < 2 ||
    genericTitle(query) ||
    !Array.isArray(subjects) ||
    !Array.isArray(types)
  )
    return empty('no-known-title-identity');
  // The caller must not silently turn a truncated metadata lookup into proof.
  if (subjects.length > 512) return empty('incomplete-known-recall');
  const key = normalize(query);
  const matches = new Map();
  const admittedTypes = types.filter((type) => [1, 2, 4, 6].includes(type));
  const prove = (terms, subject) => {
    const queries = terms.map((name) => ({ name, ...installment(name) }));
    const explicit = queries.filter((part) => part.number !== null);
    if (new Set(explicit.map((part) => part.number)).size > 1) return false;
    const item = evidence(queries, explicit, subject);
    return item.exact && item.match === 1;
  };
  for (const subject of subjects) {
    if (
      !subject ||
      !Number.isSafeInteger(subject.id) ||
      subject.id <= 0 ||
      !admittedTypes.includes(subject.type)
    )
      continue;
    const names = subjectNames(subject);
    let proven = names.some((name) => normalize(name) === key) && prove([query], subject);
    if (!proven) {
      const han = names.filter((name) =>
        /^[\p{Script=Han}\d\p{P}\p{S}\s]+$/u.test(name.normalize('NFKC'))
      );
      const latin = names.filter(
        (name) =>
          /^[\p{Script=Latin}\d\p{P}\p{S}\s]+$/u.test(name.normalize('NFKC')) &&
          (name.match(/\p{Script=Latin}/gu) || []).length >= 3
      );
      for (const left of han) {
        if ((left.match(/\p{Script=Han}/gu) || []).length < 2) continue;
        for (const right of latin) {
          const a = normalize(left),
            b = normalize(right);
          if (key !== a + b && key !== b + a) continue;
          // Visible digits, including years, must agree if both names carry them.
          const leftDigits = left.normalize('NFKC').match(/\d+/g) || [];
          const rightDigits = right.normalize('NFKC').match(/\d+/g) || [];
          if (
            leftDigits.length &&
            rightDigits.length &&
            leftDigits.join(',') !== rightDigits.join(',')
          )
            continue;
          if (prove([left, right], subject)) {
            proven = true;
            break;
          }
        }
        if (proven) break;
      }
    }
    if (proven) matches.set(`${subject.type}:${subject.id}`, subject);
  }
  const proven = [...matches.values()].sort((a, b) => a.type - b.type || a.id - b.id);
  const selected = proven.length === 1 ? proven[0] : null;
  return {
    candidates: proven.slice(0, 10).map((subject) => ({
      ...subject,
      match: 1,
      collection_total: Number.isFinite(collections(subject)) ? collections(subject) : 0
    })),
    selected,
    selectedMatch: selected ? 1 : null,
    selectionReason: selected
      ? 'known-title-identity'
      : proven.length
        ? 'ambiguous-known-title-identity'
        : 'no-known-title-identity'
  };
}

// This is a representative policy, never general search ranking. The caller
// must first prove one series and provide its complete unqualified base title.
function chooseSeriesSubject(subjects, { verified = false, query = '', base = '' } = {}) {
  if (
    !verified ||
    !Array.isArray(subjects) ||
    subjects.length < 2 ||
    subjects.length > 128 ||
    typeof query !== 'string' ||
    typeof base !== 'string' ||
    query.length > 240 ||
    base.length > 240 ||
    normalize(query).length < 2 ||
    normalize(query) !== normalize(base) ||
    genericTitle(query) ||
    /\d/u.test(query.normalize('NFKC')) ||
    subtitleBlocked(query)
  )
    return null;
  const unique = new Map();
  for (const subject of subjects) {
    if (
      !subject ||
      !Number.isSafeInteger(subject.id) ||
      subject.id <= 0 ||
      ![1, 2, 4, 6].includes(subject.type) ||
      subjectNames(subject).some(seriesSideStory) ||
      typeof subject.collection?.collect !== 'number' ||
      !Number.isFinite(subject.collection.collect) ||
      subject.collection.collect <= 0
    )
      return null;
    const key = `${subject.type}:${subject.id}`;
    // Conflicting copies cannot silently supply different counts or scores.
    if (unique.has(key) && unique.get(key) !== subject) return null;
    unique.set(key, subject);
  }
  const items = [...unique.values()];
  if (items.length < 2 || new Set(items.map((subject) => subject.type)).size !== 1) return null;
  const popular = [...items].sort((a, b) => b.collection.collect - a.collection.collect);
  if (popular[0].collection.collect >= popular[1].collection.collect * 5) return popular[0];
  // Lower-order members cannot beat the comparable-popularity group by rating.
  const peers = popular.filter(
    (subject) => subject.collection.collect * 5 > popular[0].collection.collect
  );
  if (
    peers.some(
      (subject) =>
        typeof subject.rating?.score !== 'number' ||
        !Number.isFinite(subject.rating.score) ||
        subject.rating.score <= 0 ||
        subject.rating.score > 10
    )
  )
    return null;
  const highest = Math.max(...peers.map((subject) => subject.rating.score));
  const lowest = Math.min(...peers.map((subject) => subject.rating.score));
  if (highest - lowest > 0.3 + 1e-12) {
    const best = peers.filter((subject) => subject.rating.score === highest);
    return best.length === 1 ? best[0] : null;
  }
  if (peers.some((subject) => !Number.isFinite(dateValue(subject.date)))) return null;
  const newest = Math.max(...peers.map((subject) => dateValue(subject.date)));
  const latest = peers.filter((subject) => dateValue(subject.date) === newest);
  return latest.length === 1 ? latest[0] : null;
}

// The local reader calls this only after independent, complete bilingual Vol
// evidence. Explicit-title admission remains in rankImportSubjects above.
function rankVerifiedSeriesMembers(members, types, { query = '', base = '' } = {}) {
  const valid = members.filter(
    ({ subject, volume }) =>
      subject &&
      Number.isSafeInteger(subject.id) &&
      subject.id > 0 &&
      types.includes(subject.type) &&
      Number.isInteger(volume) &&
      volume >= 0 &&
      volume < 100
  );
  const volumes = new Set(valid.map((item) => item.volume));
  const ambiguous = valid.length !== members.length || volumes.size !== valid.length;
  const ranked = valid.map(({ subject, volume }) => ({
    subject,
    volume,
    match: 0.97,
    total: Number.isFinite(collections(subject)) ? collections(subject) : 0,
    date: dateValue(subject.date)
  }));
  const representative =
    !ambiguous && volumes.size >= 2
      ? chooseSeriesSubject(
          valid.map((item) => item.subject),
          { verified: true, query, base }
        )
      : null;
  const chosen = ranked.find((item) => item.subject === representative) || null;
  const ordered = chosen ? [chosen, ...ranked.filter((item) => item !== chosen)] : ranked;
  return {
    selected: chosen?.subject || null,
    selectedMatch: chosen?.match ?? null,
    candidates: ordered.slice(0, 10).map((item) => ({
      ...item.subject,
      match: item.match,
      collection_total: item.total,
      series_volume: item.volume
    })),
    selectionReason: chosen ? 'bilingual-series-representative' : 'ambiguous-series-identity',
    seriesRepresentative: !!chosen,
    evidenceLabel: chosen ? '系列代表' : '系列身份不明确'
  };
}

// Bounded promise cache coalesces repeated multilingual folder queries. Failed
// requests never become persistent misses, and categories are part of identity.
function createSearchCache({ limit = 128, ttl = 10 * 60 * 1000, now = Date.now } = {}) {
  const cache = new Map();
  return {
    get(query, types, load) {
      const key = `${MATCHING_POLICY_VERSION}:${VERIFIED_ALIAS_VERSION}|${[...types].sort((a, b) => a - b).join(',')}|${normalize(query)}`;
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
  MATCHING_POLICY_VERSION,
  MIN_CONFIDENCE,
  IMPORT_MIN_CONFIDENCE,
  rankImportSubjects,
  rankKnownSubjects,
  chooseSeriesSubject,
  rankVerifiedSeriesMembers,
  seriesSideStory,
  installment,
  collections,
  dateValue,
  rankSubjects,
  createSearchCache
};
