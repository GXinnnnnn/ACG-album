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
function reviewScopeSql(alias = 'nodes') {
  const depth = `COALESCE((SELECT policy.match_depth FROM root_match_policy policy WHERE policy.root=${alias}.root),1)`;
  return `${alias}.depth BETWEEN 1 AND ${depth}
    AND COALESCE((SELECT policy.auto_enabled FROM root_match_policy policy WHERE policy.root=${alias}.root),1)=1
    AND COALESCE((SELECT policy.directory_kind FROM root_match_policy policy WHERE policy.root=${alias}.root),'work')<>'photo'`;
}
function pendingReviewSql(alias = '') {
  const p = alias ? alias + '.' : '';
  return `${p}kind='folder' AND ${p}confirmed=0 AND ${p}cover_source='fallback' AND NOT COALESCE(${matchedIdentitySql(alias)},0) AND ${reviewScopeSql(alias || 'nodes')}`;
}
function reviewEligible(node, policy = null) {
  return !!(
    node &&
    node.kind === 'folder' &&
    node.depth >= 1 &&
    node.depth <= (policy?.match_depth || 1) &&
    (!policy || (!!policy.auto_enabled && policy.directory_kind !== 'photo')) &&
    !node.confirmed &&
    node.cover_source === 'fallback' &&
    !(node.subject_id > 0 || node.character_id > 0)
  );
}
module.exports = {
  matchedIdentitySql,
  matchedAutomaticSql,
  pendingReviewSql,
  reviewScopeSql,
  reviewEligible
};
