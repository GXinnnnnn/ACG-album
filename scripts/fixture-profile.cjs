'use strict';
const fs = require('node:fs/promises'),
  path = require('node:path');
// Only synthetic profiles created by check-media are eligible; never use .review-data.
async function latestMediaProfile(root) {
  const base = path.join(root, 'artifacts/media-integration');
  const entries = await fs.readdir(base, { withFileTypes: true }).catch(() => []);
  const names = entries
    .filter((e) => e.isDirectory() && /^(source|packaged)-\d{4}-/.test(e.name))
    .map((e) => e.name)
    .sort((a, b) => b.slice(b.indexOf('-') + 1).localeCompare(a.slice(a.indexOf('-') + 1)));
  for (const name of names) {
    try {
      const report = JSON.parse(await fs.readFile(path.join(base, name, 'report.json'), 'utf8'));
      const profile = path.join(base, name, 'profile');
      if (report.failed === 0 && report.passed > 0 && (await fs.stat(profile)).isDirectory())
        return profile;
    } catch {}
  }
  throw new Error('No successful synthetic media profile. Run node scripts/check-media.cjs first.');
}
module.exports = { latestMediaProfile };
