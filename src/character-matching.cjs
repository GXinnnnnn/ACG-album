'use strict';
const path = require('node:path');
const { IMAGE_EXT } = require('./model.cjs');

// Keep punctuation: A.B and AB can be different people. Only typography,
// letter case and whitespace are equivalent; no subject-title stripping.
function characterKey(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/\s+/gu, ' ');
}
function characterNames(character) {
  const names = [character?.name, character?.name_cn, character?.matchedName];
  for (const alias of character?.aliases || []) if (typeof alias === 'string') names.push(alias);
  for (const item of character?.infobox || []) {
    if (!/^(?:别名|別名|中文名|简体中文名|繁体中文名|alias|aliases)$/iu.test(item?.key || ''))
      continue;
    if (typeof item.value === 'string') names.push(item.value);
    else if (Array.isArray(item.value))
      for (const alias of item.value) if (typeof alias?.v === 'string') names.push(alias.v);
  }
  return [...new Set(names.filter((name) => typeof name === 'string' && name.trim()))];
}
function safeCharacter(character, expectedId) {
  return !!(
    character &&
    Number.isSafeInteger(character.id) &&
    character.id > 0 &&
    (!character.kind || character.kind === 'character') &&
    (!expectedId || character.id === expectedId)
  );
}
function rankCharacters(query, rows, { complete = true, truncated = false } = {}) {
  const key = characterKey(query),
    byId = new Map();
  for (const row of rows || []) {
    if (!safeCharacter(row)) continue;
    const previous = byId.get(row.id);
    const names = [...new Set([...characterNames(previous), ...characterNames(row)])];
    byId.set(row.id, {
      ...previous,
      ...row,
      aliases: names,
      kind: 'character',
      exact: !!key && names.some((name) => characterKey(name) === key)
    });
  }
  const candidates = [...byId.values()]
    .sort((a, b) => Number(b.exact) - Number(a.exact) || a.id - b.id)
    .map((row) => ({ ...row, match: row.exact ? 1 : 0 }));
  const exact = candidates.filter((row) => row.exact);
  const selected = key && complete && !truncated && exact.length === 1 ? exact[0] : null;
  return {
    candidates,
    selected,
    complete: !!complete && !truncated,
    truncated: !!truncated,
    selectedMatch: selected ? 1 : null,
    selectionReason: !key
      ? 'empty-query'
      : !complete || truncated
        ? 'incomplete-recall'
        : exact.length > 1
          ? 'ambiguous-exact'
          : selected
            ? 'unique-exact'
            : 'needs-selection'
  };
}
async function searchCharacterPages(query, request, { maxPages = 3, limit = 20 } = {}) {
  const rows = [],
    seen = new Set();
  let complete = false,
    consistent = true,
    total;
  for (let page = 0; page < maxPages; page++) {
    const offset = page * limit;
    const data = await request(`/v0/search/characters?limit=${limit}&offset=${offset}`, {
      keyword: String(query).slice(0, 240)
    });
    if (!Array.isArray(data?.data)) throw new Error('Bangumi 角色检索响应无效。');
    if (data.offset !== undefined && data.offset !== offset) consistent = false;
    if (data.limit !== undefined && data.limit !== limit) consistent = false;
    if (data.total !== undefined) {
      if (
        !Number.isSafeInteger(data.total) ||
        data.total < 0 ||
        (total !== undefined && total !== data.total)
      )
        consistent = false;
      else total = data.total;
    }
    if (data.data.length > limit) consistent = false;
    for (const row of data.data) {
      if (!safeCharacter(row) || seen.has(row.id)) consistent = false;
      if (safeCharacter(row) && !seen.has(row.id)) {
        seen.add(row.id);
        rows.push(row);
      }
    }
    const received = offset + data.data.length;
    if (
      total !== undefined &&
      (received > total || (data.data.length < limit && received !== total))
    )
      consistent = false;
    if ((total !== undefined && received >= total) || data.data.length < limit) {
      complete = consistent && (total === undefined || rows.length === total);
      break;
    }
  }
  return rankCharacters(query, rows, { complete, truncated: !complete });
}
function parseCharacterId(value) {
  const text = String(value ?? '').trim();
  const match =
    /^(?:https?:\/\/(?:bgm\.tv|bangumi\.tv|chii\.in)\/character\/)?([1-9]\d*)\/?$/i.exec(text);
  const id = match && Number(match[1]);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('请输入 Bangumi 角色链接或角色 ID。');
  return id;
}
const naturalKey = (name) =>
  String(name || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\d+/g, (digits) => digits.padStart(14, '0'));
function firstImage(a, b) {
  if (
    !b ||
    (b.kind && b.kind !== 'image') ||
    !IMAGE_EXT.has(path.extname(b.name || b.path || '').toLowerCase())
  )
    return a || null;
  if (!a) return b;
  const ak = naturalKey(a.name),
    bk = naturalKey(b.name);
  return bk < ak || (bk === ak && String(b.id) < String(a.id)) ? b : a;
}
module.exports = {
  characterKey,
  characterNames,
  safeCharacter,
  rankCharacters,
  searchCharacterPages,
  parseCharacterId,
  naturalKey,
  firstImage
};
