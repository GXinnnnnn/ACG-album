'use strict';
const { normalize } = require('./model.cjs');

const SEARCH_PAGE_SIZE = 20;
const SEARCH_REQUEST_LIMIT = 3;
function primaryExact(term, subject) {
  const key = normalize(term);
  return [subject?.name, subject?.name_cn].some(
    (name) => typeof name === 'string' && normalize(name) === key
  );
}
// Search recall is separate from confidence. Keep the complete first page,
// honor the number actually returned, and bound extra pages / popularity recall.
// A truncated search can offer candidates but cannot prove subtitle uniqueness.
async function searchSubjectPages(term, types, request, { fullCandidates = false } = {}) {
  const rows = new Map();
  let offset = 0,
    complete = false,
    requests = 0,
    reliable = true;
  async function page(sort) {
    const start = sort === 'match' ? offset : 0;
    const result = await request(`/v0/search/subjects?limit=${SEARCH_PAGE_SIZE}&offset=${start}`, {
      keyword: term,
      sort,
      filter: { type: types }
    });
    requests++;
    if (!Array.isArray(result?.data)) throw new Error('Bangumi 搜索响应缺少候选数据。');
    const data = result.data.slice(0, SEARCH_PAGE_SIZE);
    if (sort === 'match' && result.offset !== undefined && result.offset !== start)
      reliable = false;
    let added = 0;
    for (const subject of data) {
      if (!Number.isSafeInteger(subject?.id) || subject.id <= 0 || !types.includes(subject.type))
        continue;
      if (rows.has(subject.id)) {
        if (sort === 'match') reliable = false;
        continue;
      }
      rows.set(subject.id, subject);
      added++;
    }
    if (sort === 'match') {
      offset += data.length;
      const total = result?.total;
      const limit =
        Number.isSafeInteger(result?.limit) && result.limit > 0 ? result.limit : SEARCH_PAGE_SIZE;
      if (start > 0 && data.length && !added) reliable = false;
      if (Number.isSafeInteger(total) && total >= 0 && offset > total) reliable = false;
      complete =
        reliable &&
        (Number.isSafeInteger(total) && total >= 0
          ? offset >= total
          : total === undefined && data.length < limit);
    }
    return { added, count: data.length };
  }
  await page('match');
  while (
    !complete &&
    (fullCandidates || ![...rows.values()].some((s) => primaryExact(term, s))) &&
    requests < SEARCH_REQUEST_LIMIT
  ) {
    // Two relevance pages plus a popularity page cover different result orders.
    const sort = requests === SEARCH_REQUEST_LIMIT - 1 ? 'heat' : 'match';
    await page(sort);
  }
  return { data: [...rows.values()], complete };
}
module.exports = { SEARCH_PAGE_SIZE, SEARCH_REQUEST_LIMIT, primaryExact, searchSubjectPages };
