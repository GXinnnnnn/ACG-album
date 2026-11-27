'use strict';

// A card's personal score is independent of shared Bangumi metadata. Only an
// explicit null restores the automatic score; never coerce empty text to zero.
function validUserRating(value) {
  return (
    value === null ||
    (typeof value === 'number' &&
      Number.isFinite(value) &&
      value >= 0 &&
      value <= 10 &&
      Math.round(value * 10) / 10 === value)
  );
}

function ensureUserRatingSchema(db) {
  if (!db.prepare('PRAGMA table_info(nodes)').all().some((column) => column.name === 'user_rating'))
    db.exec('ALTER TABLE nodes ADD COLUMN user_rating REAL DEFAULT NULL');
}

module.exports = { validUserRating, ensureUserRatingSchema };
