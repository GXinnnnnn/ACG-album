'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { guardedAliases, lookup: verifiedAliases } = require('./verified-title-aliases.cjs');
const { normalize, searchPlan, searchStages, similarity, subjectNames } = require('./model.cjs');
const {
  rankSubjects,
  rankImportSubjects,
  rankVerifiedSeriesMembers,
  seriesSideStory,
  installment,
  MIN_CONFIDENCE,
  IMPORT_MIN_CONFIDENCE
} = require('./matching.cjs');
const SUBJECT_TYPES = [1, 2, 3, 4, 6];

const MAX_ROWS = 512;
const RELATED_LIMIT = 20;
const SUBJECT_COLUMNS =
  'id,type,name,name_cn,nsfw,date,summary,infobox,collection_json,aliases_json';
const ENTITY_COLUMNS = 'kind,id,name,name_cn,summary,infobox,aliases_json';
function json(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}
function hydrate(row) {
  if (!row) return null;
  // Do not expose the large, unvalidated raw export to RPC consumers.
  const { raw_json, aliases_json, collection_json, infobox, ...data } = row;
  const aliases = json(aliases_json, []);
  const box = json(infobox, []);
  const collection = json(collection_json, {});
  return {
    ...data,
    aliases: Array.isArray(aliases) ? aliases.filter((x) => typeof x === 'string') : [],
    infobox: Array.isArray(box) ? box : [],
    ...(collection_json !== undefined
      ? {
          collection:
            collection && typeof collection === 'object' && !Array.isArray(collection)
              ? collection
              : {}
        }
      : {}),
    source: 'local-index'
  };
}
function trigrams(key) {
  const points = [...key],
    grams = new Set();
  for (let i = 0; i + 2 < points.length; i++) grams.add(points.slice(i, i + 3).join(''));
  return [...grams].map((x) => '"' + x.replace(/"/g, '""') + '"').join(' OR ');
}
function validate({ query, kind = 'subject', types = SUBJECT_TYPES, subjectId, limit = 10 }) {
  if (typeof query !== 'string' || [...query].length > 240)
    throw new TypeError('query must be a string of at most 240 Unicode characters');
  if (!['subject', 'person', 'character'].includes(kind))
    throw new TypeError('Invalid local index kind');
  if (!Array.isArray(types) || !types.length || types.some((x) => !SUBJECT_TYPES.includes(x)))
    throw new TypeError('Invalid subject types');
  if (subjectId !== undefined && (!Number.isSafeInteger(subjectId) || subjectId <= 0))
    throw new TypeError('Invalid subjectId');
  if (!Number.isInteger(limit) || limit < 1 || limit > 10)
    throw new RangeError('limit must be 1..10');
  return { query: query.trim(), kind, types: [...new Set(types)], subjectId, limit };
}

// The connection is owned here, opened read-only and never migrated or optimized.
// Metadata/schema probes are bounded; startup never counts or scans real tables.
function createLocalIndex({ localIndexPath, resourcesPath = process.resourcesPath } = {}) {
  let db = null;
  let state = { available: false, variant: null, dataVersion: null, entities: [] };
  let filename;
  function fail(error) {
    try {
      db?.close();
    } catch {}
    db = null;
    state = { ...state, available: false, error: String(error.message || error) };
  }
  try {
    filename =
      localIndexPath ||
      (resourcesPath && path.join(resourcesPath, 'local-index', 'subjects.sqlite'));
    if (filename) {
      filename = path.resolve(filename);
      state.path = filename;
      if (!fs.statSync(filename).isFile()) throw new Error('Local index path is not a file');
      let manifest = {};
      const manifestPath = path.join(path.dirname(filename), 'manifest.json');
      if (fs.existsSync(manifestPath)) {
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        if (manifest.readerSchemaVersion !== undefined && manifest.readerSchemaVersion !== 1)
          throw new Error('Unsupported local index schema version');
      }
      db = new DatabaseSync(filename, { readOnly: true });
      db.exec('PRAGMA query_only=ON; PRAGMA cache_size=-8192; PRAGMA busy_timeout=1000');
      for (const sql of [
        'SELECT id,type,name,name_cn,summary,infobox,aliases_json,collection_json,raw_json FROM subjects LIMIT 0',
        'SELECT subject_id,key FROM name_keys INDEXED BY name_keys_type_key LIMIT 0',
        'SELECT key,subject_id,type FROM names_fts LIMIT 0',
        'SELECT kind,id,name,name_cn,summary,infobox,aliases_json,raw_json FROM entities LIMIT 0',
        'SELECT kind,id,key,name FROM entity_keys INDEXED BY entity_keys_kind_key LIMIT 0',
        'SELECT key,kind,id FROM entity_names_fts LIMIT 0',
        'SELECT source_kind,source_id,target_kind,target_id,relation_type FROM links INDEXED BY links_source LIMIT 0',
        'SELECT source_kind,source_id,target_kind,target_id FROM links INDEXED BY links_target LIMIT 0'
      ])
        db.prepare(sql).all();
      const source = json(
        db.prepare("SELECT value FROM metadata WHERE key='source'").get()?.value,
        {}
      );
      state = {
        ...state,
        available: true,
        variant:
          /lite/.test(source.mode || '') || source.rawRecordsPreserved === false ? 'lite' : 'full',
        dataVersion:
          manifest.dataVersion ||
          source.dataVersion ||
          String(source.archiveName || '')
            .replace(/^dump-/, '')
            .replace(/\.zip$/, '') ||
          null,
        entities: ['subject', 'person', 'character']
      };
    }
  } catch (error) {
    // The Standard edition deliberately omits this optional bundled database.
    // Explicit paths and damaged/inaccessible files still report their real error.
    if (localIndexPath || error.code !== 'ENOENT' || error.path !== filename) fail(error);
  }

  function status() {
    return { ...state, entities: [...state.entities] };
  }
  function readSubject(id) {
    if (!db) return null;
    try {
      return hydrate(db.prepare(`SELECT ${SUBJECT_COLUMNS} FROM subjects WHERE id=?`).get(id));
    } catch (error) {
      fail(error);
      return null;
    }
  }
  function readCharacter(id) {
    if (!db || !Number.isSafeInteger(id) || id <= 0) return null;
    try {
      return hydrate(
        db.prepare(`SELECT ${ENTITY_COLUMNS} FROM entities WHERE kind='character' AND id=?`).get(id)
      );
    } catch (error) {
      fail(error);
      return null;
    }
  }
  function staffFor(subjectId) {
    if (!db) return [];
    try {
      return db
        .prepare(
          `SELECT e.id,e.name,e.name_cn,l.relation_type AS relation FROM links l INDEXED BY links_source
        JOIN entities e ON e.kind='person' AND e.id=l.target_id
        WHERE l.source_kind='subject' AND l.source_id=? AND l.target_kind='person'
        UNION SELECT e.id,e.name,e.name_cn,l.relation_type AS relation FROM links l INDEXED BY links_target
        JOIN entities e ON e.kind='person' AND e.id=l.source_id
        WHERE l.target_kind='subject' AND l.target_id=? AND l.source_kind='person' LIMIT 101`
        )
        .all(subjectId, subjectId)
        .slice(0, 100);
    } catch (error) {
      fail(error);
      return [];
    }
  }
  function search(args = {}) {
    const options = validate(args);
    const empty = () => ({
      ...status(),
      query: options.query,
      kind: options.kind,
      candidates: [],
      selected: null,
      complete: false,
      truncated: false
    });
    if (!db) return empty();
    try {
      const result =
        options.kind === 'subject'
          ? searchSubjects(db, options, args.mode === 'import')
          : searchEntities(db, options);
      return { ...status(), ...result, query: options.query, kind: options.kind };
    } catch (error) {
      fail(error);
      return empty();
    }
  }
  return {
    status,
    search,
    readSubject,
    readCharacter,
    staffFor,
    close() {
      try {
        db?.close();
      } finally {
        db = null;
        state.available = false;
      }
    }
  };
}

function exactSubjectRows(db, types, key, budget) {
  const placeholders = types.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT subject_id,key FROM name_keys INDEXED BY name_keys_type_key WHERE type IN (${placeholders}) AND key=? ORDER BY subject_id LIMIT ?`
    )
    .all(...types, key, budget);
  for (const record of verifiedAliases(key, normalize)) {
    if (
      !types.includes(record.type) ||
      rows.length >= budget ||
      rows.some((row) => row.subject_id === record.id)
    )
      continue;
    const row = db
      .prepare(`SELECT ${SUBJECT_COLUMNS} FROM subjects WHERE id=? AND type=?`)
      .get(record.id, record.type);
    if (row && guardedAliases(hydrate(row)).some((alias) => normalize(alias) === key))
      rows.push({ subject_id: record.id, key });
  }
  return rows;
}
function oneLatinTypo(query, archived) {
  const a = normalize(query),
    b = normalize(archived);
  if (
    /^[A-Z]{2,6}$/.test(String(query).normalize('NFKC').trim()) ||
    !/^[\p{Script=Latin}0-9]+$/u.test(a) ||
    !/^[\p{Script=Latin}0-9]+$/u.test(b) ||
    (a.match(/\p{Script=Latin}/gu) || []).length < 6 ||
    (b.match(/\p{Script=Latin}/gu) || []).length < 6 ||
    a === b ||
    Math.abs(a.length - b.length) > 1 ||
    JSON.stringify(a.match(/\d+/g) || []) !== JSON.stringify(b.match(/\d+/g) || [])
  )
    return false;
  let i = 0,
    j = 0,
    edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (a.length >= b.length) i++;
    if (b.length >= a.length) j++;
  }
  return edits + (a.length - i) + (b.length - j) === 1;
}
function volumeAfterStem(name, stem) {
  const value = String(name || '').normalize('NFKC');
  const key = normalize(stem);
  let end = 0;
  while (end < value.length && normalize(value.slice(0, end)).length < key.length) end++;
  if (normalize(value.slice(0, end)) !== key) return null;
  const match = /^(?:vol(?:ume)?\.?\s*(\d{1,2})|第\s*(\d{1,2})\s*卷|卷\s*(\d{1,2}))(.*)$/iu.exec(
    value.slice(end).trim()
  );
  if (!match) return null;
  const tail = match[4];
  if (tail.trim() && !/^(?:\s+|\s*[:：—–~-]\s*)\p{L}[\p{L}\p{N}\p{P}\p{S}\s]{0,47}$/u.test(tail))
    return null;
  if (seriesSideStory(tail) || /\b(?:edition|remaster(?:ed)?|remake|season|part)\b/i.test(tail))
    return null;
  return Number(match[1] ?? match[2] ?? match[3]);
}
function bilingualVolumeFamily(db, group, types, limit, budget) {
  const parts = group.parts;
  if (
    parts.length !== 2 ||
    parts.some(
      (part) =>
        /^[A-Z]{2,6}$/.test(part.normalize('NFKC').trim()) ||
        /\p{N}/u.test(part) ||
        installment(part).number !== null
    ) ||
    !parts.some((part) => (part.match(/\p{Script=Han}/gu) || []).length >= 4) ||
    !parts.some((part) => (part.match(/\p{Script=Latin}/gu) || []).length >= 6)
  )
    return null;
  const placeholders = types.map(() => '?').join(',');
  let retrievedRows = 0;
  const incomplete = () => ({
    selected: null,
    selectedMatch: null,
    candidates: [],
    complete: false,
    truncated: true,
    retrievedRows,
    maxRows: MAX_ROWS,
    types,
    terms: [group.whole, ...parts],
    titleGroups: [group],
    candidatesTruncated: false,
    queryHits: {},
    warnings: ['incomplete-family-recall'],
    selectionReason: 'incomplete-recall'
  });
  const rowsByPart = [];
  for (const part of parts) {
    const key = normalize(part);
    const rows = db
      .prepare(
        `SELECT subject_id,key,name FROM name_keys WHERE type IN (${placeholders}) AND key>=? AND key<? LIMIT ?`
      )
      .all(...types, key, key + '\uffff', budget - retrievedRows);
    retrievedRows += rows.length;
    if (retrievedRows >= budget) return incomplete();
    rowsByPart.push(rows);
  }
  const evidence = rowsByPart.map((rows, i) => {
    const byId = new Map();
    for (const row of rows) {
      const volume = volumeAfterStem(row.name, parts[i]);
      if (volume === null) continue;
      if (!byId.has(row.subject_id)) byId.set(row.subject_id, []);
      byId.get(row.subject_id).push({ volume, name: row.name, key: row.key });
    }
    return byId;
  });
  const ids = [...evidence[0].keys()].filter((id) => evidence[1].has(id));
  if (ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) return incomplete();
  if (ids.length < 2) return null;
  const subjects = db
    .prepare(
      `SELECT ${SUBJECT_COLUMNS} FROM subjects WHERE id IN (${ids.map(() => '?')}) AND type IN (${placeholders})`
    )
    .all(...ids, ...types)
    .map(hydrate);
  if (subjects.length !== ids.length) return incomplete();
  const members = subjects
    .filter((subject) => !subjectNames(subject).some(seriesSideStory))
    .map((subject) => {
      const numbers = new Set(
        evidence.flatMap((side) => side.get(subject.id).map((item) => item.volume))
      );
      return { subject, volume: numbers.size === 1 ? [...numbers][0] : NaN };
    });
  const ranked = rankVerifiedSeriesMembers(members, types);
  return {
    ...ranked,
    candidates: ranked.candidates.slice(0, limit),
    complete: true,
    truncated: false,
    retrievedRows,
    maxRows: MAX_ROWS,
    types,
    terms: [group.whole, ...parts],
    titleGroups: [group],
    candidatesTruncated: members.length > limit,
    queryHits: Object.fromEntries(
      ids.map((id) => [id, evidence.flatMap((side) => side.get(id).map((item) => item.key))])
    ),
    warnings: [],
    familyEvidence: members.map(({ subject, volume }) => ({
      id: subject.id,
      volume,
      names: evidence.map((side) => side.get(subject.id).map((item) => item.name))
    }))
  };
}

// A concatenated translation is not a fuzzy title fragment: both complete
// names must resolve to the same unique typed subject. Query that bounded exact
// identity domain before the much broader FTS OR recall can consume its budget.
function exactBilingualSubject(
  db,
  plan,
  types,
  limit,
  importing,
  wholePhase,
  budget,
  allowSeriesRepresentative
) {
  if (wholePhase.titleGroups.length) return null;
  const phases = searchStages(plan);
  const grouped = phases.filter(
    (phase) =>
      phase.titleGroups.length === 1 &&
      normalize(phase.titleGroups[0].whole) === normalize(wholePhase.terms[0])
  );
  if (!grouped.length) return null;
  const placeholders = types.map(() => '?').join(',');
  const cache = new Map();
  let retrievedRows = 0,
    complete = true;
  function exact(term) {
    const key = normalize(term);
    if (cache.has(key)) return cache.get(key);
    if (retrievedRows >= budget) {
      complete = false;
      return [];
    }
    const rows = exactSubjectRows(db, types, key, budget - retrievedRows);
    retrievedRows += rows.length;
    if (retrievedRows >= budget) complete = false;
    cache.set(key, rows);
    return rows;
  }
  // An actual archived whole name keeps precedence over inferred translations.
  if (wholePhase.terms.some((term) => exact(term).length) || !complete) return null;
  for (const phase of grouped) {
    const group = phase.titleGroups[0];
    if (group.parts.length !== 2) continue;
    const parts = [...group.parts];
    let editionTranslation = null;
    for (let i = 0; i < parts.length; i++) {
      const marked =
        /\s+(Remastered|Remake|(?:Complete|Special|Definitive|Ultimate|Deluxe)\s+Edition)$/i.exec(
          parts[i]
        );
      if (!marked || !/\p{Script=Han}/u.test(parts[1 - i])) continue;
      const foreignRows = exact(parts[i]);
      if (!foreignRows.length || !complete) continue;
      const qualified = parts[1 - i] + ' ' + marked[1];
      const qualifiedRows = exact(qualified);
      if (
        complete &&
        qualifiedRows.some((row) =>
          foreignRows.some((foreign) => foreign.subject_id === row.subject_id)
        )
      ) {
        editionTranslation = { original: parts[1 - i], qualified, qualifier: marked[1] };
        parts[1 - i] = qualified;
      }
    }
    let neutralEdition = null;
    for (let i = 0; i < parts.length; i++) {
      const original = parts[i];
      if (!exact(original).length && /\s+Complete Edition$/i.test(original)) {
        // Do not merge a separately archived edition: this fallback requires
        // no exact identity for its full English name and two exact base names.
        parts[i] = original.replace(/\s+Complete Edition$/i, '').trim();
        neutralEdition = { original, base: parts[i] };
      }
    }
    let spellingCorrection = null;
    for (let i = 0; i < parts.length; i++) {
      if (exact(parts[i]).length || !/^[\p{Script=Han}\p{N}]+$/u.test(normalize(parts[1 - i])))
        continue;
      const anchorIds = [...new Set(exact(parts[1 - i]).map((row) => Number(row.subject_id)))];
      if (
        !complete ||
        !anchorIds.length ||
        anchorIds.some((id) => !Number.isSafeInteger(id) || id <= 0)
      )
        continue;
      const anchors = db
        .prepare(
          `SELECT ${SUBJECT_COLUMNS} FROM subjects WHERE id IN (${anchorIds.map(() => '?')}) AND type IN (${placeholders})`
        )
        .all(...anchorIds, ...types)
        .map(hydrate);
      if (anchors.length !== anchorIds.length) {
        complete = false;
        break;
      }
      const repairs = new Map(
        anchors
          .flatMap((subject) => subjectNames(subject))
          .filter((name) => oneLatinTypo(parts[i], name))
          .map((name) => [normalize(name), name])
      );
      if (repairs.size === 1) {
        const corrected = [...repairs.values()][0];
        if (exact(corrected).length && complete) {
          spellingCorrection = { original: parts[i], corrected };
          parts[i] = corrected;
        }
      }
    }
    const rowsByPart = parts.map(exact);
    if (!complete) continue;
    if (rowsByPart.every((rows) => !rows.length)) {
      const family = allowSeriesRepresentative
        ? bilingualVolumeFamily(db, group, types, limit, budget - retrievedRows)
        : null;
      if (family)
        return {
          ...family,
          retrievedRows: retrievedRows + family.retrievedRows,
          threshold: importing ? IMPORT_MIN_CONFIDENCE : MIN_CONFIDENCE,
          stages: [
            { terms: wholePhase.terms, titleGroups: [], complete: true, scope: 'exact-whole' },
            {
              terms: family.terms,
              titleGroups: family.titleGroups,
              complete: family.complete,
              scope: 'bilingual-volume-family',
              retrievedRows: retrievedRows + family.retrievedRows
            }
          ]
        };
      continue;
    }
    const common = rowsByPart
      .map((rows) => new Set(rows.map((row) => Number(row.subject_id))))
      .reduce((a, b) => new Set([...a].filter((id) => b.has(id))));
    if (![...common].every((id) => Number.isSafeInteger(id) && id > 0)) continue;
    const ids = [
      ...new Set(rowsByPart.flatMap((rows) => rows.map((row) => Number(row.subject_id))))
    ];
    if (ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) continue;
    const subjects = db
      .prepare(
        `SELECT ${SUBJECT_COLUMNS} FROM subjects WHERE id IN (${ids.map(() => '?')}) AND type IN (${placeholders})`
      )
      .all(...ids, ...types)
      .map(hydrate);
    if (subjects.length !== ids.length) continue;
    const hits = new Map();
    rowsByPart.forEach((rows, i) =>
      rows.forEach((row) => {
        if (!hits.has(Number(row.subject_id))) hits.set(Number(row.subject_id), new Set());
        hits.get(Number(row.subject_id)).add(normalize(parts[i]));
      })
    );
    const titleGroups = [{ ...group, parts }],
      terms = [...new Set([group.whole, ...parts])];
    const rank = importing ? rankImportSubjects : rankSubjects;
    const ranked = rank(terms, subjects, types, {
      complete: true,
      titleGroups,
      queryHits: hits,
      series: plan.series
    });
    if (!common.size && !ranked.selected) {
      // An exact numbered translation can legitimately verify the other
      // language's unnumbered family. It still needs that term's real FTS hit;
      // do not let this exact-only preflight suppress the existing proof path.
      const needsFamilyRecall = subjects.some((subject) => {
        const names = subjectNames(subject);
        const numbers = new Set(
          parts
            .filter(
              (part) =>
                names.some((name) => normalize(name) === normalize(part)) &&
                hits.get(subject.id)?.has(normalize(part))
            )
            .map(installment)
            .map((part) => part.number)
            .filter((number) => number !== null)
        );
        if (numbers.size !== 1) return false;
        const number = [...numbers][0];
        return parts.some((part) => {
          const query = installment(part);
          if (query.number !== null) return false;
          const family = names
            .map(installment)
            .filter((name) => name.base === query.base && name.number !== null);
          return family.length > 0 && family.every((name) => name.number === number);
        });
      });
      if (needsFamilyRecall) return null;
    }
    const score =
      ranked.selected && ranked.candidates.find((item) => item.id === ranked.selected.id)?.match;
    const editionConflict = group.parts.some(
      (part) =>
        /\b(?:edition|remastered|remake)\s*$/i.test(part) &&
        subjects.some(
          (subject) =>
            subject.id !== ranked.selected?.id &&
            [subject.name, subject.name_cn].some((name) => normalize(name) === normalize(part))
        )
    );
    const selected =
      common.size === 1 &&
      !editionConflict &&
      ranked.selected &&
      common.has(ranked.selected.id) &&
      score === 1
        ? ranked.selected
        : null;
    if (!selected && !ranked.candidates.some((item) => item.match === 1)) continue;
    return {
      ...ranked,
      selected,
      selectedMatch: selected ? score : null,
      candidates: ranked.candidates.slice(0, limit),
      complete: true,
      truncated: false,
      types,
      terms,
      titleGroups,
      queryHits: Object.fromEntries([...hits].map(([id, keys]) => [id, [...keys]])),
      retrievedRows,
      maxRows: MAX_ROWS,
      candidatesTruncated: subjects.length > limit,
      selectionReason: selected
        ? 'exact-bilingual-identity'
        : editionConflict
          ? 'conflicting-edition-identity'
          : 'ambiguous-bilingual-identity',
      threshold: importing ? IMPORT_MIN_CONFIDENCE : MIN_CONFIDENCE,
      stages: [
        { terms: wholePhase.terms, titleGroups: [], complete: true, scope: 'exact-whole' },
        {
          terms,
          titleGroups,
          complete: true,
          retrievedRows,
          scope: 'exact-bilingual',
          ...(neutralEdition ? { neutralEdition } : {}),
          ...(spellingCorrection ? { spellingCorrection } : {}),
          ...(editionTranslation ? { editionTranslation } : {})
        }
      ],
      warnings: []
    };
  }
  return null;
}
function searchSubjects(db, { query, types, limit }, importing) {
  const plan = searchPlan(query);
  const original = String(query).normalize('NFKC');
  const parentheticalNumber = [
    ...original.matchAll(/(?:\(\s*([ivxlc]{1,8})\s*\)|\[\s*([ivxlc]{1,8})\s*\])/giu)
  ].some(([, round, square]) => installment('Series ' + (round || square)).number !== null);
  const allowSeriesRepresentative =
    !parentheticalNumber &&
    !/\p{N}/u.test(original) &&
    installment(original).number === null &&
    !/(?:第\s*[一二三四五六七八九十百〇零]+\s*[卷部作章季期]|(?:vol(?:ume)?\.?|卷)\s*[一二三四五六七八九十百〇零ivxlc]+(?:\s|[)\]】]|$))/iu.test(
      original
    );
  const placeholders = types.map(() => '?').join(',');
  const subjects = new Map(),
    hits = new Map(),
    warnings = new Set(),
    stages = [];
  const rank = importing ? rankImportSubjects : rankSubjects;
  const threshold = importing ? IMPORT_MIN_CONFIDENCE : MIN_CONFIDENCE;
  let retrievedRows = 0,
    complete = true,
    truncated = false;
  let ranked = { candidates: [], selected: null },
    terms = [],
    titleGroups = [];
  function take(rows, termKey) {
    retrievedRows += rows.length;
    if (retrievedRows >= MAX_ROWS) {
      complete = false;
      truncated = true;
      warnings.add('retrieval-cap');
    }
    const ids = new Set();
    for (const row of rows) {
      const id = Number(row.subject_id);
      if (!Number.isSafeInteger(id) || id <= 0) {
        complete = false;
        continue;
      }
      if (!hits.has(id)) hits.set(id, new Set());
      hits.get(id).add(termKey || row.key);
      if (!subjects.has(id)) ids.add(id);
    }
    if (!ids.size) return;
    const rowsById = db
      .prepare(
        `SELECT ${SUBJECT_COLUMNS} FROM subjects WHERE id IN (${[...ids].map(() => '?').join(',')}) AND type IN (${placeholders})`
      )
      .all(...ids, ...types);
    for (const row of rowsById) subjects.set(row.id, hydrate(row));
    if (rowsById.length !== ids.size) {
      complete = false;
      warnings.add('missing-or-mistyped-subject');
    }
  }
  const rerank = () =>
    rank(terms, [...subjects.values()], types, {
      complete,
      titleGroups,
      queryHits: hits,
      series: plan.series
    });
  const credible = () =>
    ranked.candidates.some((x) => (importing ? x.match > threshold : x.match >= threshold));
  for (const phase of searchStages(plan)) {
    if (!phase.terms.length) continue;
    // Only inspect translations of this hypothesis, after all earlier main
    // titles have had their normal exact/fuzzy admission opportunity.
    const exactBilingual = exactBilingualSubject(
      db,
      plan,
      types,
      limit,
      importing,
      phase,
      MAX_ROWS - retrievedRows,
      allowSeriesRepresentative
    );
    if (exactBilingual)
      return {
        ...exactBilingual,
        retrievedRows: retrievedRows + exactBilingual.retrievedRows,
        stages: [...stages, ...exactBilingual.stages]
      };
    // Notes are independent fallback hypotheses, just as in the production worker.
    terms = phase.terms;
    titleGroups = phase.titleGroups || [];
    subjects.clear();
    hits.clear();
    const keys = [...new Set(terms.map(normalize).filter(Boolean))];
    for (const key of keys) {
      if (retrievedRows >= MAX_ROWS) break;
      take(exactSubjectRows(db, types, key, MAX_ROWS - retrievedRows));
    }
    ranked = rerank();
    // Exact recall alone omits numbered sequels and close fuzzy competitors.
    // Probe FTS even after an exact hit; a full budget must stay manual.
    for (const key of keys) {
      if (retrievedRows >= MAX_ROWS) break;
      const expression = trigrams(key);
      if (!expression) {
        if (!subjects.size) {
          complete = false;
          warnings.add('short-query-without-trigrams');
        }
        continue;
      }
      take(
        db
          .prepare(
            `SELECT subject_id,key FROM names_fts WHERE names_fts MATCH ? AND CAST(type AS INTEGER) IN (${placeholders}) LIMIT ?`
          )
          .all(expression, ...types, MAX_ROWS - retrievedRows),
        key
      );
    }
    ranked = rerank();
    stages.push({
      terms,
      titleGroups,
      complete,
      retrievedRows,
      ...(phase.series ? { series: true } : {})
    });
    if (credible() || !complete) break;
  }
  // Production import permits verified API exact names in bounded pages. A local
  // truncated recall cannot prove absence of a conflicting archived identity.
  const selected = complete ? ranked.selected : null;
  return {
    ...ranked,
    selected,
    selectedMatch: selected
      ? (ranked.candidates.find((x) => x.id === selected.id)?.match ?? null)
      : null,
    candidates: ranked.candidates.slice(0, limit),
    complete,
    truncated,
    types,
    terms,
    titleGroups,
    queryHits: Object.fromEntries([...hits].map(([id, set]) => [id, [...set]])),
    retrievedRows,
    maxRows: MAX_ROWS,
    candidatesTruncated: subjects.size > limit,
    selectionReason: !complete
      ? 'incomplete-recall'
      : ranked.selectionReason || (selected ? 'ranked-match' : 'needs-selection'),
    threshold,
    stages,
    warnings: [...warnings]
  };
}

function context(kind, id) {
  return `(EXISTS (SELECT 1 FROM links l INDEXED BY links_source WHERE l.source_kind=${kind} AND l.source_id=${id} AND l.target_kind='subject' AND l.target_id=?)
    OR EXISTS (SELECT 1 FROM links l INDEXED BY links_target WHERE l.target_kind=${kind} AND l.target_id=${id} AND l.source_kind='subject' AND l.source_id=?))`;
}
function searchEntities(db, { query, kind, subjectId, limit }) {
  const key = normalize(query),
    warnings = [];
  let complete = true,
    truncated = false,
    selected = null,
    rows = [],
    candidates = [];
  const contextual = subjectId !== undefined;
  const subject = contextual
    ? db.prepare('SELECT id,type,name,name_cn FROM subjects WHERE id=?').get(subjectId) || null
    : null;
  const base = () => ({
    candidates,
    selected,
    complete,
    truncated,
    subjectId: subjectId ?? null,
    subject,
    maxRows: MAX_ROWS,
    retrievedRows: rows.length,
    warnings,
    threshold: 0.92,
    minGap: 0.08
  });
  if (!key || (contextual && !subject))
    return { ...base(), selectionReason: !key ? 'empty-query' : 'subject-not-found' };
  const args = contextual ? [subjectId, subjectId] : [];
  rows = db
    .prepare(
      `SELECT k.id,k.key,k.name FROM entity_keys k INDEXED BY entity_keys_kind_key WHERE k.kind=? AND k.key=? ${contextual ? 'AND ' + context('k.kind', 'k.id') : ''} ORDER BY k.id LIMIT ?`
    )
    .all(kind, key, ...args, MAX_ROWS);
  if (!rows.length) {
    const expression = trigrams(key);
    if (expression)
      rows = db
        .prepare(
          `SELECT id,key FROM entity_names_fts WHERE entity_names_fts MATCH ? AND kind=? ${contextual ? 'AND ' + context('entity_names_fts.kind', 'CAST(entity_names_fts.id AS INTEGER)') : ''} LIMIT ?`
        )
        .all(expression, kind, ...args, MAX_ROWS);
    else {
      complete = false;
      warnings.push('short-query-without-trigrams');
    }
  }
  if (rows.length >= MAX_ROWS) {
    complete = false;
    truncated = true;
    warnings.push('retrieval-cap');
  }
  const hits = new Map();
  for (const row of rows) {
    const score = similarity(key, row.key);
    if (!hits.has(row.id) || score > hits.get(row.id).match)
      hits.set(row.id, {
        match: score,
        score,
        matchedKey: row.key,
        matchedName: row.name || null,
        exact: key === row.key
      });
  }
  if (hits.size) {
    const entities = db
      .prepare(
        `SELECT ${ENTITY_COLUMNS} FROM entities WHERE kind=? AND id IN (${[...hits.keys()].map(() => '?').join(',')})`
      )
      .all(kind, ...hits.keys());
    if (entities.length !== hits.size) {
      complete = false;
      warnings.push('missing-entity');
    }
    candidates = entities
      .map((x) => ({ ...hydrate(x), ...hits.get(x.id) }))
      .sort((a, b) => b.match - a.match || a.id - b.id);
  }
  const total = candidates.length,
    best = candidates[0],
    next = candidates[1];
  let selectionReason = !complete
    ? 'incomplete-recall'
    : best?.exact && next?.exact
      ? 'ambiguous-exact'
      : best?.exact
        ? 'unique-exact'
        : best &&
            best.match >= 0.92 &&
            [...key].length >= 5 &&
            (!next || best.match - next.match >= 0.08)
          ? 'strong-fuzzy'
          : 'needs-selection';
  candidates = candidates.slice(0, limit);
  const related = db.prepare(`SELECT s.id,s.type,s.name,s.name_cn FROM subjects s JOIN (
    SELECT target_id id FROM links INDEXED BY links_source WHERE source_kind=? AND source_id=? AND target_kind='subject'
    UNION SELECT source_id id FROM links INDEXED BY links_target WHERE target_kind=? AND target_id=? AND source_kind='subject'
    ) r ON s.id=r.id ORDER BY s.id LIMIT ?`);
  for (const candidate of candidates) {
    if (!candidate.matchedName) {
      candidate.matchedName =
        db
          .prepare(
            'SELECT name FROM entity_keys INDEXED BY entity_keys_kind_key WHERE kind=? AND key=? AND id=?'
          )
          .get(kind, candidate.matchedKey, candidate.id)?.name || null;
      if (!candidate.matchedName) {
        complete = false;
        selectionReason = 'incomplete-recall';
        warnings.push('missing-entity-key');
      }
    }
    const links = related.all(kind, candidate.id, kind, candidate.id, RELATED_LIMIT + 1);
    candidate.relatedSubjects = links.slice(0, RELATED_LIMIT);
    candidate.relatedSubjectIds = candidate.relatedSubjects.map((x) => x.id);
    candidate.relatedSubjectsTruncated = links.length > RELATED_LIMIT;
    candidate.relatedSubjectsComplete = !candidate.relatedSubjectsTruncated;
    candidate.subjectContextMatched = contextual;
  }
  if (complete && ['unique-exact', 'strong-fuzzy'].includes(selectionReason))
    selected = candidates[0];
  return {
    ...base(),
    selectionReason,
    candidatesTruncated: total > limit,
    maxRelatedSubjects: RELATED_LIMIT
  };
}

module.exports = { createLocalIndex, MAX_ROWS };
