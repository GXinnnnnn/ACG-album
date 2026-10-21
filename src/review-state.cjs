'use strict';

// Confidence belongs to an automatic identity assignment. A manually selected
// cover has its own confirmation lifecycle and must not inherit that evidence.
function exactAutomaticIdentitySql(alias = '') {
  const p = alias ? alias + '.' : '';
  return `${p}match_confidence=1 AND ${p}manual_subject=0 AND ${p}manual_character=0 AND (${p}subject_id>0 OR ${p}character_id>0)`;
}
function exactAutomaticSql(alias = '') {
  const p = alias ? alias + '.' : '';
  return `${p}manual_cover=0 AND ${exactAutomaticIdentitySql(alias)}`;
}
function pendingReviewSql(alias = '') {
  const p = alias ? alias + '.' : '';
  return `${p}kind='folder' AND (${p}match_review=1 OR (${p}confirmed=0 AND ${p}cover_source IN ('fallback','bangumi','bangumi-character')))`;
}
module.exports = { exactAutomaticIdentitySql, exactAutomaticSql, pendingReviewSql };
