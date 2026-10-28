'use strict';

// SQLite cannot use Intl.Collator directly. Persist compact character weights
// plus a one-byte group: symbols/numbers/non-Han names first, Han names last.
// Chinese names retain pinyin order while SQL retains indexed pages. This
// approximates whole-string collation: expansions/contractions and rare
// supplementary-plane characters do not have the complete OS collation rules.
const NATURAL_SORT_VERSION = `zh-cn-grouped-bmp-v2:${process.versions.icu}`;
let weights;
const encodeWeight = (rank) => {
  let code = rank + 32;
  if (code >= 0xd800) code += 0x800;
  return String.fromCharCode(code);
};
function characterWeights() {
  if (weights) return weights;
  const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
  const chars = [];
  for (let code = 0; code <= 0xffff; code++) {
    if (code >= 0xd800 && code <= 0xdfff) continue;
    const char = String.fromCharCode(code);
    if (collator.compare(char, '') !== 0) chars.push(char);
  }
  chars.sort(collator.compare);
  weights = new Map();
  let previous,
    rank = 0;
  for (const char of chars) {
    if (previous === undefined || collator.compare(previous, char) !== 0) rank++;
    // Leave the final BMP code points available for supplementary fallback.
    if (rank >= 0xf7dc) throw new Error('Chinese filename collation exceeds key capacity');
    weights.set(char, encodeWeight(rank));
    previous = char;
  }
  // Empty weights also remove ICU-ignorable control and combining characters.
  for (let code = 0; code <= 0xffff; code++) {
    if (code >= 0xd800 && code <= 0xdfff) continue;
    const char = String.fromCharCode(code);
    if (!weights.has(char)) weights.set(char, '');
  }
  return weights;
}
function weightedKey(text, table) {
  let key = '';
  for (const token of text.match(/\d+|[^\d]/gu) || []) {
    if (/^\d/.test(token)) {
      const digits = token.replace(/^0+(?=\d)/, '');
      // Magnitude precedes digit bytes, so arbitrary integer lengths sort
      // naturally. A fixed two-character length avoids numeric token ambiguity.
      const high = Math.floor(digits.length / 60000),
        low = digits.length % 60000;
      key += table.get('0') + encodeWeight(high + 1) + encodeWeight(low + 1) + digits;
    } else {
      key += table.has(token) ? table.get(token) : '\ufffe' + token;
    }
  }
  return key;
}
function sortKey(value) {
  const text = String(value ?? '')
    .normalize('NFKC')
    .toLowerCase();
  if (!text) return '';
  const table = characterWeights(),
    start = text.search(/[\p{L}\p{N}]/u),
    body = start > 0 ? text.slice(start) : text,
    group = /^\p{Script=Han}/u.test(body) ? '1' : '0';
  // Leading brackets/emoji/whitespace decorate a name rather than moving
  // [中文] into the English group or ahead of every undecorated Chinese name.
  // Symbol-only names retain their original collation in the first group.
  const key = group + weightedKey(body, table);
  // Break decoration ties only after the meaningful name. This delimiter is
  // below every character weight and contains no NUL; normal names cost just
  // the group byte, and case/leading-zero equivalents still share one key.
  return start > 0 ? key + '\u0001' + weightedKey(text, table) : key;
}
module.exports = { sortKey, NATURAL_SORT_VERSION };
