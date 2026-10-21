'use strict';
(async () => {
  for (const item of [
    { url: 'https://api.bgm.tv/v0/subjects/326' },
    {
      url: 'https://api.bgm.tv/v0/search/subjects?limit=2',
      body: { keyword: '星际牛仔', sort: 'match', filter: { type: [2] } }
    }
  ]) {
    try {
      const r = await fetch(item.url, {
        method: item.body ? 'POST' : 'GET',
        headers: { 'User-Agent': 'ACGAlbum/0.1.0', 'Content-Type': 'application/json' },
        body: item.body ? JSON.stringify(item.body) : undefined,
        signal: AbortSignal.timeout(20000)
      });
      const j = await r.json();
      console.log(
        JSON.stringify(
          {
            url: item.url,
            status: r.status,
            id: j.id,
            name: j.name_cn,
            total: j.total,
            results: j.data?.map((s) => ({ id: s.id, name: s.name_cn })),
            error: j.error
          },
          null,
          2
        )
      );
    } catch (e) {
      console.log(
        JSON.stringify({ url: item.url, error: e.message, cause: e.cause?.message }, null, 2)
      );
      process.exitCode = 1;
    }
  }
})();
