'use strict';

const SUBJECT_TYPES = Object.freeze([1, 2, 4, 6]);

// Whitelist renderer input. Absent options retain the legacy global default;
// explicit false is a durable choice, not a missing value.
function importOptions(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options))
    throw new Error('导入选项无效。');
  if (!Object.hasOwn(options, 'onlineMatch')) {
    if (Object.hasOwn(options, 'subjectTypes')) throw new Error('请明确选择是否在线匹配。');
    return {};
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
  if (options.onlineMatch && !types.length) throw new Error('在线匹配时请至少选择一种作品类型。');
  return {
    onlineMatch: options.onlineMatch,
    subjectTypes: types.length ? types : [...SUBJECT_TYPES]
  };
}

module.exports = { SUBJECT_TYPES, importOptions };
