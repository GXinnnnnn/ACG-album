'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { normalize, searchPlan, similarity } = require('./model.cjs');
const {
  rankSubjects,
  rankImportSubjects,
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

function searchSubjects(db, { query, types, limit }, importing) {
  const plan = searchPlan(query);
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
    rank(terms, [...subjects.values()], types, { complete, titleGroups, queryHits: hits });
  const credible = () =>
    ranked.candidates.some((x) => (importing ? x.match > threshold : x.match >= threshold));
  for (const phase of [plan, ...(plan.fallbacks || [])]) {
    if (!phase.terms.length) continue;
    // Notes are independent fallback hypotheses, just as in the production worker.
    terms = phase.terms;
    titleGroups = phase.titleGroups || [];
    subjects.clear();
    hits.clear();
    const keys = [...new Set(terms.map(normalize).filter(Boolean))];
    for (const key of keys) {
      if (retrievedRows >= MAX_ROWS) break;
      take(
        db
          .prepare(
            `SELECT subject_id,key FROM name_keys INDEXED BY name_keys_type_key WHERE type IN (${placeholders}) AND key=? ORDER BY subject_id LIMIT ?`
          )
          .all(...types, key, MAX_ROWS - retrievedRows)
      );
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
    stages.push({ terms, titleGroups, complete, retrievedRows });
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
