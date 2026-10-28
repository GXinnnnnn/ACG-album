'use strict';

const SUBJECT_TYPES = Object.freeze([1, 2, 4, 6]);

// Whitelist renderer input. Absent options retain the legacy global default;
// explicit false is a durable choice, not a missing value.
function importOptions(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options))
    throw new Error('导入选项无效。');
  const directoryKind = options.directoryKind;
  const characterCover = options.characterCover;
  const matchDepth = options.matchDepth;
  if (
    matchDepth !== undefined &&
    (!Number.isInteger(matchDepth) || matchDepth < 1 || matchDepth > 8)
  )
    throw new Error('匹配深度应为 1 到 8 的整数。');
  if (directoryKind !== undefined && !['work', 'character', 'photo'].includes(directoryKind))
    throw new Error('目录类型无效。');
  if (characterCover !== undefined && !['local-first', 'bangumi'].includes(characterCover))
    throw new Error('角色封面来源无效。');
  if (characterCover !== undefined && directoryKind !== 'character')
    throw new Error('角色封面来源仅适用于角色目录。');
  if (directoryKind !== undefined && !Object.hasOwn(options, 'onlineMatch'))
    throw new Error('请明确选择是否在线匹配。');
  if (!Object.hasOwn(options, 'onlineMatch')) {
    if (Object.hasOwn(options, 'subjectTypes')) throw new Error('请明确选择是否在线匹配。');
    return matchDepth === undefined ? {} : { matchDepth };
  }
  if (typeof options.onlineMatch !== 'boolean') throw new Error('在线匹配选项无效。');
  const supplied = options.subjectTypes;
  if (
    supplied !== undefined &&
    (!Array.isArray(supplied) ||
      supplied.length > 4 ||
      supplied.some((t) => !SUBJECT_TYPES.includes(t)))
  )
    throw new Error('作品类型仅支持动画、漫画、游戏和三次元。');
  const types = [...new Set(supplied || [])].sort((a, b) => a - b);
  if (options.onlineMatch && (!directoryKind || directoryKind === 'work') && !types.length)
    throw new Error('在线匹配时请至少选择一种作品类型。');
  const extra =
    directoryKind === undefined
      ? {}
      : {
          directoryKind,
          ...(directoryKind === 'character'
            ? { characterCover: characterCover || 'local-first' }
            : {})
        };
  return {
    onlineMatch: directoryKind === 'photo' ? false : options.onlineMatch,
    subjectTypes: types.length ? types : [...SUBJECT_TYPES],
    ...(matchDepth === undefined ? {} : { matchDepth }),
    ...extra
  };
}

module.exports = { SUBJECT_TYPES, importOptions };
