'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { parseReleaseVersion } = require('../scripts/release-version.cjs');

const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/publish-edge-addons.yml'), 'utf8');
const triggerBlock = workflow.match(/^on:\n  push:\n    tags:\n((?:      - '[^']+'\n)+)/m);
assert.ok(triggerBlock, 'workflow must be tag-filtered under push');
const candidateGlobs = [...triggerBlock[1].matchAll(/^      - '([^']+)'$/gm)].map((match) => match[1]);
assert.deepEqual(candidateGlobs, ['v*.*.*', '*.*.*']);
assert.doesNotMatch(workflow, /^\s+branches:/m, 'workflow must not run for branch pushes');
assert.doesNotMatch(workflow, /^\s+(?:workflow_dispatch|pull_request|schedule):/m, 'workflow must have no manual, PR, or scheduled trigger');
assert.match(workflow, /EDGE_ADDONS_API_KEY:\s*\$\{\{\s*secrets\.EDGE_ADDONS_API_KEY\s*\}\}/);
assert.doesNotMatch(workflow, /vars\.EDGE_ADDONS_API_KEY/, 'the API key must never fall back to a plain Actions variable');

const publisher = fs.readFileSync(path.join(__dirname, '../scripts/publish-edge-addons.mjs'), 'utf8');
assert.match(publisher, /Required encrypted GitHub Actions secret EDGE_ADDONS_API_KEY is unavailable/);
assert.match(publisher, /No API request was made/);

function candidateGlobMatches(pattern, tag) {
  const regex = pattern
    .split('*')
    .map((part) => part.replace(/[|\\{}()[\]^$+?.]/g, '\\$&'))
    .join('[^/]*');
  return new RegExp(`^${regex}$`).test(tag);
}

function isCandidateTag(tag) {
  return candidateGlobs.some((pattern) => candidateGlobMatches(pattern, tag));
}

for (const [tag, version] of [['1.2.3', '1.2.3'], ['v1.2.3', '1.2.3'], ['0.10.2', '0.10.2']]) {
  assert.ok(isCandidateTag(tag), `${tag} should match a candidate GitHub glob`);
  assert.equal(parseReleaseVersion(tag), version);
}
for (const tag of ['v1.2.3-rc.1', 'release1.2.3', 'v01.2.3', 'v1.2', 'latest']) {
  if (tag !== 'v1.2' && tag !== 'latest') assert.ok(isCandidateTag(tag), `${tag} demonstrates a broad candidate glob`);
  assert.equal(parseReleaseVersion(tag), null, `${tag} must be rejected by the stable-version gate`);
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function verifyRedirectIsRejected() {
  const { request } = await import('../scripts/safe-fetch.mjs');
  let apiHits = 0;
  let otherOriginHits = 0;
  const destination = http.createServer((_req, res) => {
    otherOriginHits += 1;
    res.writeHead(200).end('unexpectedly reached redirect destination');
  });
  const destinationPort = await listen(destination);
  const api = http.createServer((_req, res) => {
    apiHits += 1;
    res.writeHead(302, { Location: `http://127.0.0.1:${destinationPort}/collect` }).end();
  });
  const apiPort = await listen(api);

  try {
    await assert.rejects(
      request(`http://127.0.0.1:${apiPort}/redirect`, {
        method: 'GET',
        headers: { Authorization: 'ApiKey dummy-test-only' },
      }, 'Redirect test'),
      /request failed before an HTTP response/,
    );
    assert.equal(apiHits, 1, 'the original API endpoint should receive only the initial request');
    assert.equal(otherOriginHits, 0, 'credentials must not be forwarded to the redirect destination');
  } finally {
    await Promise.all([close(api), close(destination)]);
  }
}

verifyRedirectIsRejected()
  .then(() => process.stdout.write('Edge Add-ons release guard and redirect tests passed.\n'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
