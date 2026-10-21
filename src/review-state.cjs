'use strict';

// A selected Bangumi identity has already passed the matching policy. Confidence
// is ranking evidence, not a second request to approve a successfully matched cover.
function matchedIdentitySql(alias = '') {
  const p = alias ? alias + '.' : '';
  return `(${p}subject_id>0 OR ${p}character_id>0)`;
}
function matchedAutomaticSql(alias = '') {
  const p = alias ? alias + '.' : '';
  return `${p}manual_cover=0 AND ${matchedIdentitySql(alias)}`;
}
function pendingReviewSql(alias = '') {
  const p = alias ? alias + '.' : '';
  return `${p}kind='folder' AND ${p}confirmed=0 AND ${p}cover_source='fallback' AND NOT COALESCE(${matchedIdentitySql(alias)},0)`;
}
module.exports = { matchedIdentitySql, matchedAutomaticSql, pendingReviewSql };
