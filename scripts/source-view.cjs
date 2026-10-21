const fs = require('node:fs'),
  path = require('node:path');
const out = path.join(__dirname, '..', 'artifacts', 'source-view');
fs.mkdirSync(out, { recursive: true });
for (const rel of ['src/ui/app.js', 'src/ui/styles.css', 'src/library-worker.cjs']) {
  const text = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
  fs.writeFileSync(
    path.join(out, path.basename(rel) + '.txt'),
    text
      .split('\n')
      .flatMap((line, i) =>
        (line.match(/.{1,900}/g) || ['']).map((s, j) => `${i + 1}:${j * 900} ${s}`)
      )
      .join('\n')
  );
}
