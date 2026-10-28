'use strict';
const HOME_COPY_DEFAULTS = Object.freeze({
  eyebrow: 'YOUR PERSONAL COLLECTION',
  title: '我的相册',
  description: '把散落的画面，整理成喜欢的世界。'
});
const HOME_COPY_LIMITS = Object.freeze({ eyebrow: 120, title: 80, description: 240 });
function normalizeHomeCopy(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('首页文案格式无效。');
  if (Object.keys(value).some((key) => !Object.hasOwn(HOME_COPY_DEFAULTS, key)))
    throw new Error('首页文案包含不支持的字段。');
  const result = {};
  for (const [key, fallback] of Object.entries(HOME_COPY_DEFAULTS)) {
    const text = Object.hasOwn(value, key) ? value[key] : fallback;
    if (
      typeof text !== 'string' ||
      /[\u0000-\u001f\u007f]/u.test(text) ||
      text.length > HOME_COPY_LIMITS[key]
    )
      throw new Error(`首页文案应为不超过 ${HOME_COPY_LIMITS[key]} 个字符的单行文本。`);
    result[key] = text.trim() || fallback;
  }
  return result;
}
module.exports = { HOME_COPY_DEFAULTS, HOME_COPY_LIMITS, normalizeHomeCopy };
