'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { parseReleaseVersion, evaluatePublishedRelease } = require('../scripts/release-version.cjs');
const { resolveProductId } = require('../scripts/resolve-product-id.cjs');

const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/publish-edge-addons.yml'), 'utf8');
assert.match(workflow, /^on:\n  release:\n    types:\n      - published\n/m, 'workflow must trigger only on published GitHub Releases');
assert.doesNotMatch(workflow, /^\s+push:/m, 'tag and branch pushes must not trigger store submission');
assert.doesNotMatch(workflow, /^\s+(?:workflow_dispatch|pull_request|schedule):/m, 'workflow must have no manual, PR, or scheduled trigger');
assert.match(workflow, /github\.event_name == 'release' && github\.event\.action == 'published' && github\.event\.release\.prerelease == false/);
assert.match(workflow, /needs\.validate\.outputs\.eligible == 'true' && needs\.validate\.outputs\.in_main == 'true'/, 'only an eligible release in main history may build or publish');
assert.match(workflow, /stable-id-crx-\$\{\{ needs\.validate\.outputs\.tag \}\}/, 'release must download the CRX built from its validated tag');
assert.match(workflow, /gh release upload "\$RELEASE_TAG" "\$crx" --clobber/, 'versioned CRX must be attached to the GitHub Release');
assert.match(workflow, /node scripts\/publish-edge-addons\.mjs/);
assert.match(workflow, /EDGE_ADDONS_API_KEY:\s*\$\{\{\s*secrets\.EDGE_ADDONS_API_KEY\s*\}\}/);
assert.doesNotMatch(workflow, /vars\.EDGE_ADDONS_API_KEY/, 'the API key must never fall back to a plain Actions variable');
assert.doesNotMatch(workflow, /EDGE_ADDONS_PRODUCT_ID/, 'workflow must not depend on an unavailable product-ID variable');

const buildWorkflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/build-main-crx.yml'), 'utf8');
assert.match(buildWorkflow, /^on:\n  push:\n    branches:\n      - main\n  workflow_call:/m, 'every main push must build CRX and release jobs may reuse the build');
assert.match(buildWorkflow, /MULTIPASS_MAIN_CRX_SIGNING_KEY_20261028/);
assert.match(buildWorkflow, /hjkmgjalkohpaboeabhmjkidfbekmpda/);
assert.match(buildWorkflow, /scripts\/verify-crx3\.py/);

const publisher = fs.readFileSync(path.join(__dirname, '../scripts/publish-edge-addons.mjs'), 'utf8');
assert.match(publisher, /Required encrypted GitHub Actions secret EDGE_ADDONS_API_KEY is unavailable/);
assert.match(publisher, /No API request was made/);

const allowlistedProductId = '59f80db2-0cdb-44dc-9a9e-c723b24190e2';
assert.equal(resolveProductId(undefined, allowlistedProductId), allowlistedProductId, 'missing product ID must use the hardcoded target');
assert.equal(resolveProductId('', allowlistedProductId), allowlistedProductId, 'empty product ID must use the hardcoded target');
assert.equal(resolveProductId(` ${allowlistedProductId} `, allowlistedProductId), allowlistedProductId);
assert.throws(() => resolveProductId('different-product', allowlistedProductId), /conflicts with the allowlisted/);

for (const [tag, version] of [['1.2.3', '1.2.3'], ['v1.2.3', '1.2.3'], ['0.10.2', '0.10.2']]) {
  assert.equal(parseReleaseVersion(tag), version);
}
for (const tag of ['v1.2.3-rc.1', 'release1.2.3', 'v01.2.3', 'v1.2', 'latest', 'test-v1.2.3']) {
  assert.equal(parseReleaseVersion(tag), null, `${tag} must be rejected by the stable-version gate`);
}

const matchingVersions = {
  'package.json': '1.2.3',
  'package-lock.json': '1.2.3',
  'vendor/common/manifest.json': '1.2.3',
};
assert.equal(evaluatePublishedRelease({
  eventName: 'release', eventAction: 'published', prerelease: false, tag: 'v1.2.3', versions: matchingVersions,
}).eligible, true, 'published stable release with matching sources should be eligible');
for (const update of [
  { eventName: 'push' },
  { eventAction: 'created' },
  { prerelease: true },
  { tag: 'v1.2.3-rc.1' },
  { tag: 'test-v1.2.3' },
  { versions: { ...matchingVersions, 'package.json': '9.9.9' } },
]) {
  assert.equal(evaluatePublishedRelease({
    eventName: 'release', eventAction: 'published', prerelease: false, tag: 'v1.2.3', versions: matchingVersions, ...update,
  }).eligible, false, `release gate must reject ${JSON.stringify(update)}`);
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
  .then(() => require('./helpers/edge_addons_submission_mock.cjs').runEdgeAddonsSubmissionMock())
  .then(() => process.stdout.write('Edge Add-ons release, product-ID, redirect, and offline submission tests passed.\n'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
