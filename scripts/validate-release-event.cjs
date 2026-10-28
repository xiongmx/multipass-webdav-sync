'use strict';

const fs = require('node:fs');
const { evaluatePublishedRelease } = require('./release-version.cjs');

const result = evaluatePublishedRelease({
  eventName: process.env.RELEASE_EVENT_NAME,
  eventAction: process.env.RELEASE_EVENT_ACTION,
  prerelease: process.env.RELEASE_PRERELEASE === 'true',
  tag: process.env.RELEASE_TAG,
  versions: {
    'package.json': require('../package.json').version,
    'package-lock.json': require('../package-lock.json').packages?.['']?.version,
    'vendor/common/manifest.json': require('../vendor/common/manifest.json').version,
  },
});

const output = process.env.GITHUB_OUTPUT;
if (output) {
  const lines = [`eligible=${result.eligible}`];
  if (result.eligible) {
    lines.push(`version=${result.version}`);
    lines.push(`tag=${process.env.RELEASE_TAG}`);
  }
  fs.appendFileSync(output, `${lines.join('\n')}\n`);
}

console.log(`Release gate: ${result.eligible ? 'eligible' : 'skipped'} — ${result.reason}`);
