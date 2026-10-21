'use strict';

function validRepository(value) {
  if (typeof value !== 'string') return false;
  const parts = value.split('/');
  return (
    parts.length === 2 &&
    /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(parts[0]) &&
    /^[a-z\d._-]{1,100}$/i.test(parts[1]) &&
    !/^\.{1,2}$/.test(parts[1])
  );
}

module.exports = { validRepository };
