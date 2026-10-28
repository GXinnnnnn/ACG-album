'use strict';
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const sharp = require('sharp');
const { matchedAutomaticSql } = require('./review-state.cjs');
const {
  safeCharacter,
  rankCharacters,
  searchCharacterPages,
  parseCharacterId
} = require('./character-matching.cjs');

function createCharacterLibrary(e) {
  const { db, q, one, run, getNode, hydrate, localIndex, policy, api, assertLive, accessScope } = e;
  for (const [name, type] of [
    ['character_id', 'INTEGER'],
    ['manual_character', 'INTEGER NOT NULL DEFAULT 0'],
    ['custom_character', 'TEXT']
  ])
    if (!q('PRAGMA table_info(nodes)').some((column) => column.name === name))
      db.exec(`ALTER TABLE nodes ADD COLUMN ${name} ${type}`);
  for (const [name, type] of [
    ['directory_kind', "TEXT NOT NULL DEFAULT 'work'"],
    ['character_cover', "TEXT NOT NULL DEFAULT 'local-first'"],
    ['match_depth', 'INTEGER NOT NULL DEFAULT 1'],
    ['auto_enabled', 'INTEGER NOT NULL DEFAULT 1']
  ])
    if (!q('PRAGMA table_info(root_match_policy)').some((column) => column.name === name))
      db.exec(`ALTER TABLE root_match_policy ADD COLUMN ${name} ${type}`);
  db.exec(
    'CREATE TABLE IF NOT EXISTS character_metadata(id INTEGER PRIMARY KEY,json TEXT,updated REAL); CREATE INDEX IF NOT EXISTS nodes_character ON nodes(character_id)'
  );
  let sequence = 0;
  const coverFile = (id) => path.join(e.cacheHome(), 'covers', `character-${id}.webp`);
  function metadata(folder) {
    if (folder.custom_character) {
      try {
        return {
          json: folder.custom_character,
          updated: JSON.parse(folder.custom_character).cached_at
        };
      } catch {}
    }
    return folder.character_id
      ? one('SELECT json,updated FROM character_metadata WHERE id=?', folder.character_id)
      : null;
  }
  function eligible(folder, p) {
    if (
      p.kind !== 'character' ||
      !folder ||
      folder.kind !== 'folder' ||
      folder.depth < 1 ||
      folder.depth > (p.matchDepth || 1) ||
      p.enabled === false ||
      folder.missing ||
      folder.manual_character ||
      folder.manual_subject ||
      folder.custom_character
    )
      return false;
    if (!folder.character_id) return true;
    const row = metadata(folder);
    if (!row) return true;
    const data = JSON.parse(row.json);
    if (!p.networkEnabled) return false;
    return (
      data.resources_complete === false ||
      (p.characterCover === 'bangumi' &&
        !folder.manual_cover &&
        !!(data.images?.large || data.images?.common || data.images?.medium) &&
        !fs.existsSync(coverFile(folder.character_id)))
    );
  }
  function guard(folder, explicit = false, job = e.matchJob(folder, explicit)) {
    const base = e.matchGuard(folder, job, explicit);
    const characterId = folder.character_id,
      manual = folder.manual_character,
      custom = folder.custom_character;
    return () => {
      const current = getNode(folder.id);
      return (
        base() &&
        current?.character_id === characterId &&
        current.manual_character === manual &&
        current.custom_character === custom
      );
    };
  }
  function continuation(folder, job, explicit) {
    // Identity/policy may change through this save; cancellation and credential
    // generations must always remain those of the original request.
    return guard(folder, explicit, {
      ...e.matchJob(folder, explicit),
      root: job.root,
      generation: job.generation,
      epoch: job.epoch,
      access: job.access
    });
  }
  function track(job) {
    e.jobs.add(job);
    return job.finally(() => e.jobs.delete(job));
  }
  function save(data, folder, manual, live, options = {}) {
    return track(saveContents(data, folder, manual, live, options));
  }
  async function saveContents(
    character,
    folder,
    manual,
    live,
    { refresh = false, onIdentitySaved, matchConfidence } = {}
  ) {
    assertLive(live);
    if (!safeCharacter(character)) throw new Error('Bangumi 角色数据无效。');
    const row = one('SELECT json FROM character_metadata WHERE id=?', character.id);
    let previous;
    try {
      previous = row && JSON.parse(row.json);
    } catch {}
    const local = character.source === 'local-index';
    const same = previous?.id === character.id;
    const previousOnline = same && previous.details_source === 'online';
    const data = { ...character, kind: 'character' };
    if (local && previousOnline) {
      for (const [key, value] of Object.entries(previous))
        if (
          value !== null &&
          value !== '' &&
          value !== undefined &&
          (!Array.isArray(value) || value.length)
        )
          data[key] = value;
    }
    data.details_source = local ? (previousOnline ? 'online' : 'local-index') : 'online';
    data.source = data.details_source;
    data.cached_at = local ? (previousOnline ? previous.cached_at || 0 : 0) : Date.now();
    data.access_scope = local ? (previousOnline ? previous.access_scope || '' : '') : accessScope();
    const p = policy(folder),
      image = data.images?.large || data.images?.common || data.images?.medium;
    let file = fs.existsSync(coverFile(character.id)) ? coverFile(character.id) : null;
    let complete = !image || (file && previous?.cover_url === image && !refresh);
    if (!local && image && p.characterCover === 'bangumi' && !folder.manual_cover && !complete) {
      const controller = new AbortController();
      e.controllers.add(controller);
      try {
        const url = new URL(image);
        if (url.protocol === 'https:' && /(^|\.)bgm\.tv$/i.test(url.hostname)) {
          const response = await fetch(url, {
            redirect: 'error',
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)])
          });
          assertLive(live);
          if (response.ok && Number(response.headers.get('content-length') || 0) < 20000000) {
            const buffer = Buffer.from(await response.arrayBuffer());
            assertLive(live);
            if (buffer.length > 20000000) throw new Error('角色立绘过大。');
            const target = coverFile(character.id),
              temp = target + `.${++sequence}.tmp`;
            try {
              await sharp(buffer, { limitInputPixels: 40000000 })
                .resize({ width: 1000, height: 1500, fit: 'inside', withoutEnlargement: true })
                .webp({ quality: 90 })
                .toFile(temp);
              assertLive(live);
              await fsp.rename(temp, target);
              file = target;
              complete = true;
            } finally {
              if (path.dirname(path.resolve(temp)) === path.resolve(e.cacheHome(), 'covers'))
                await fsp.rm(temp, { force: true }).catch(() => {});
            }
          }
        }
      } catch (error) {
        assertLive(live);
      } finally {
        e.controllers.delete(controller);
      }
    }
    assertLive(live);
    data.local_cover = file;
    data.cover_url = complete ? image || '' : previous?.cover_url || '';
    data.resources_complete = local
      ? previousOnline
        ? (previous.resources_complete ?? false)
        : false
      : p.characterCover !== 'bangumi' || folder.manual_cover
        ? true
        : !!complete;
    const serialized = JSON.stringify(data);
    const markdown = path.join(e.cacheHome(), 'metadata', `character-${character.id}.md`),
      temp = markdown + `.${++sequence}.tmp`;
    try {
      await fsp.writeFile(
        temp,
        `# ${data.name_cn || data.name || ''}\n\n- 角色：https://bgm.tv/character/${character.id}\n\n## 简介\n\n${data.summary || '暂无简介'}\n\n## 信息\n\n${(data.infobox || []).map((item) => '- ' + item.key + '：' + (typeof item.value === 'string' ? item.value : JSON.stringify(item.value))).join('\n')}\n`,
        'utf8'
      );
      assertLive(live);
      await fsp.rename(temp, markdown);
    } finally {
      if (path.dirname(path.resolve(temp)) === path.resolve(e.cacheHome(), 'metadata'))
        await fsp.rm(temp, { force: true }).catch(() => {});
    }
    assertLive(live);
    const current = getNode(folder.id);
    if (!current || current.missing) return null;
    db.exec('BEGIN');
    try {
      run(
        'INSERT OR REPLACE INTO character_metadata VALUES(?,?,?)',
        character.id,
        serialized,
        Date.now()
      );
      run(
        "UPDATE nodes SET character_id=?,manual_character=?,custom_character=NULL,subject_id=NULL,manual_subject=0,album_kind=CASE WHEN ?=1 THEN 'character' ELSE album_kind END,intro=CASE WHEN ?=1 THEN 1 ELSE intro END WHERE id=?",
        character.id,
        manual ? 1 : current.manual_character,
        manual ? 1 : 0,
        manual ? 1 : 0,
        folder.id
      );
      if (!current.manual_cover) {
        if (file && p.characterCover === 'bangumi')
          run(
            "UPDATE nodes SET cover=?,cover_source='bangumi-character',confirmed=CASE WHEN cover=? THEN confirmed ELSE 0 END WHERE id=?",
            'character:' + character.id,
            'character:' + character.id,
            folder.id
          );
        else if (current.cover?.startsWith('subject:') || current.cover?.startsWith('character:'))
          run('UPDATE nodes SET cover=NULL,cover_source=NULL,confirmed=0 WHERE id=?', folder.id);
      }
      if (manual) {
        run('DELETE FROM match_pending WHERE id=?', folder.id);
        run(
          'UPDATE nodes SET match_confidence=NULL,match_review=0,confirmed=CASE WHEN ?=1 THEN 1 ELSE confirmed END WHERE id=?',
          current.match_review,
          folder.id
        );
      } else if (Number.isFinite(matchConfidence))
        run(
          'UPDATE nodes SET match_confidence=?,match_review=0 WHERE id=?',
          matchConfidence,
          folder.id
        );
      run(
        `UPDATE nodes SET confirmed=1,match_review=0 WHERE id=? AND ${matchedAutomaticSql()}`,
        folder.id
      );
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    onIdentitySaved?.(getNode(folder.id));
    if (!getNode(folder.id).manual_cover && !getNode(folder.id).cover)
      await e.refreshLocalCover(folder.id);
    e.send('changed', { id: folder.id, ...(!manual && !refresh ? { matching: true } : {}) });
    return hydrate(getNode(folder.id));
  }
  function recall(query) {
    if (!localIndex.status().available)
      return { candidates: [], selected: null, complete: true, truncated: false };
    const result = localIndex.search({ query, kind: 'character', limit: 10 });
    return rankCharacters(query, result.candidates, {
      complete: result.complete && !result.candidatesTruncated,
      truncated: result.truncated || result.candidatesTruncated
    });
  }
  async function match(folder, explicit, keyword, queuedJob) {
    if (!explicit && !eligible(folder, policy(folder))) return hydrate(folder);
    const job = queuedJob || e.matchJob(folder, explicit);
    let live = guard(folder, explicit, job);
    assertLive(live);
    const query = String(keyword || folder.name)
        .trim()
        .slice(0, 240),
      p = policy(folder);
    let result = recall(query);
    const selection = () => ({
      ...hydrate(getNode(folder.id)),
      ...result,
      needs_selection: true,
      searchAccess: { tokenPresent: e.tokenPresent() },
      kind: 'character'
    });
    if (explicit) {
      if (!e.paused()) {
        try {
          const online = await searchCharacterPages(query, (endpoint, body) =>
            api(endpoint, body, live)
          );
          result = rankCharacters(query, [...result.candidates, ...online.candidates], {
            complete: result.complete && online.complete,
            truncated: result.truncated || online.truncated
          });
        } catch (error) {
          assertLive(live);
          if (!result.candidates.length) throw error;
        }
      }
      return selection();
    }
    let chosen = folder.character_id
      ? { id: folder.character_id, kind: 'character' }
      : result.selected;
    if (!chosen && p.networkEnabled && !e.paused()) {
      const online = await searchCharacterPages(query, (endpoint, body) =>
        api(endpoint, body, live)
      );
      result = rankCharacters(query, [...result.candidates, ...online.candidates], {
        complete: result.complete && online.complete,
        truncated: result.truncated || online.truncated
      });
      chosen = result.selected;
    }
    if (!chosen) return hydrate(getNode(folder.id));
    // Only a newly selected, unique exact result supplies matching evidence.
    // Enriching an existing identity never invents confidence for legacy rows.
    const matchConfidence = !folder.character_id ? result.selectedMatch : undefined;
    if (!folder.character_id && chosen.source === 'local-index') {
      await save(chosen, folder, false, live, {
        matchConfidence,
        onIdentitySaved: (current) => {
          live = continuation(current, job, false);
        }
      });
      folder = getNode(folder.id);
      assertLive(live);
    }
    if (!p.networkEnabled) return hydrate(getNode(folder.id));
    if (e.paused()) return { ...hydrate(getNode(folder.id)), networkDeferred: true };
    const detail = await api('/v0/characters/' + chosen.id, undefined, live);
    if (!safeCharacter(detail, chosen.id)) throw new Error('Bangumi 角色 ID 与检索结果不一致。');
    return save(detail, folder, false, live, { matchConfidence });
  }
  async function bind(folder, { url, custom }) {
    if (custom) {
      const name = String(custom.name || '').trim(),
        summary = String(custom.summary || '').trim();
      if (!name || name.length > 240 || summary.length > 30000)
        throw new Error('请填写角色名称（最多240字），简介最多30000字。');
      const data = {
        kind: 'character',
        source: 'custom',
        name,
        name_cn: name,
        summary,
        cached_at: Date.now()
      };
      run(
        "UPDATE nodes SET character_id=NULL,manual_character=1,custom_character=?,subject_id=NULL,manual_subject=0,album_kind='character',intro=1,match_confidence=NULL,match_review=0,confirmed=CASE WHEN match_review=1 THEN 1 ELSE confirmed END WHERE id=?",
        JSON.stringify(data),
        folder.id
      );
      run('DELETE FROM match_pending WHERE id=?', folder.id);
      if (!folder.manual_cover && /^(?:subject|character):/.test(folder.cover || '')) {
        run('UPDATE nodes SET cover=NULL,cover_source=NULL WHERE id=?', folder.id);
        await e.refreshLocalCover(folder.id);
      }
      e.send('changed', { id: folder.id });
      return hydrate(getNode(folder.id));
    }
    const id = parseCharacterId(url),
      job = e.matchJob(folder, true),
      live = guard(folder, true, job);
    const local = localIndex.readCharacter(id);
    if (safeCharacter(local, id)) {
      let detailLive;
      await save(local, folder, true, live, {
        onIdentitySaved: (current) => {
          detailLive = continuation(current, job, true);
        }
      });
      folder = getNode(folder.id);
      if (!policy(folder).networkEnabled || e.paused()) return hydrate(folder);
      try {
        const detail = await api('/v0/characters/' + id, undefined, detailLive);
        if (safeCharacter(detail, id)) return await save(detail, folder, true, detailLive);
      } catch {
        /* The explicit offline identity is already durable. */
      }
      return hydrate(getNode(folder.id));
    }
    const detail = await api('/v0/characters/' + id, undefined, live);
    if (!safeCharacter(detail, id)) throw new Error('Bangumi 角色 ID 与链接不一致。');
    return save(detail, folder, true, live);
  }
  async function refresh(folder) {
    if (folder.custom_character) return hydrate(folder);
    if (!folder.character_id) throw new Error('尚未关联角色条目。');
    const live = guard(folder, true);
    const detail = await api('/v0/characters/' + folder.character_id, undefined, live, {
      refresh: true
    });
    if (!safeCharacter(detail, folder.character_id))
      throw new Error('Bangumi 角色 ID 与当前关联不一致。');
    return save(detail, folder, !!folder.manual_character, live, { refresh: true });
  }
  return { metadata, eligible, match, bind, refresh, coverFile };
}
module.exports = { createCharacterLibrary };
