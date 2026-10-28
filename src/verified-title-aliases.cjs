'use strict';

// Reviewed 2026-10-27. Official product-title evidence, not live fetch results:
// https://store.steampowered.com/app/1144400/?l=schinese
// https://store.steampowered.com/app/1144400/?l=english
// https://www.nekonyansoft.com/blog/senren-banka-release-date-new-announcements-and-other-news
// Search-index titles were checked by the release reviewer. Full page bodies
// were unavailable in that environment; this module performs no network I/O.
const VERIFIED_ALIAS_VERSION = 1;
const records = Object.freeze([
  Object.freeze({
    id: 172612,
    type: 4,
    expectedName: '千恋＊万花',
    aliases: Object.freeze(['Senren＊Banka'])
  })
]);
function guardedAliases(subject) {
  const record = records.find(
    (entry) =>
      entry.id === subject?.id &&
      entry.type === subject?.type &&
      typeof subject.name === 'string' &&
      subject.name.normalize('NFKC').trim() === entry.expectedName.normalize('NFKC')
  );
  return record ? [...record.aliases] : [];
}
function lookup(normalizedKey, normalize) {
  return records.filter((record) =>
    record.aliases.some((alias) => normalize(alias) === normalizedKey)
  );
}
module.exports = { VERIFIED_ALIAS_VERSION, guardedAliases, lookup };
