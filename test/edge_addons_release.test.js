'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { parseReleaseVersion, evaluatePublishedRelease } = require('../scripts/release-version.cjs');
const { resolveProductId } = require('../scripts/resolve-product-id.cjs');

const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/publish-edge-addons.yml'), 'utf8');
assert.match(workflow, /^on:\n  release:\n    types:\n      - published\n/m, 'workflow must trigger only on published GitHub Releases');
assert.doesNotMatch(workflow, /^\s+push:/m, 'tag and branch pushes must not trigger store submission');
assert.doesNotMatch(workflow, /^\s+(?:workflow_dispatch|pull_request|schedule):/m, 'workflow must have no manual, PR, or scheduled trigger');
assert.match(workflow, /github\.event_name == 'release' && github\.event\.action == 'published' && github\.event\.release\.prerelease == false/);
assert.match(workflow, /needs\.validate\.outputs\.eligible == 'true' && needs\.validate\.outputs\.in_main == 'true'/, 'only an eligible release in main history may build or publish');
assert.match(workflow, /github\.run_attempt == 1/, 'publish must not run on a workflow rerun');
assert.match(workflow, /source_sha: \$\{\{ steps\.release-gate\.outputs\.source_sha \}\}/, 'validation must export the complete release source SHA');
assert.match(workflow, /source_ref: \$\{\{ needs\.validate\.outputs\.source_sha \}\}/, 'reusable build must use the immutable source SHA');
assert.match(workflow, /ref: \$\{\{ needs\.validate\.outputs\.source_sha \}\}/, 'publish checkout must use the immutable source SHA');
assert.match(workflow, /stable-id-crx-v\$\{\{ needs\.validate\.outputs\.version \}\}/, 'release must download the CRX artifact for its validated version');
assert.match(workflow, /release-crx\/multipass-webdav-sync-v\$\{RELEASE_VERSION\}\.crx/, 'GitHub Release asset must use the concise versioned filename');
assert.match(workflow, /RELEASE_VERSION: \$\{\{ needs\.validate\.outputs\.version \}\}/, 'attach shell must receive RELEASE_VERSION');
assert.match(workflow, /validate-crx-metadata\.cjs/, 'CRX metadata must be checked before attachment');
assert.match(workflow, /gh release upload "\$RELEASE_TAG" "\$crx" --clobber/, 'versioned CRX must be attached to the GitHub Release');
assert.doesNotMatch(workflow, /secrets:\s*inherit/, 'the reusable CRX workflow must not inherit unrelated store secrets');
assert.match(workflow, /MULTIPASS_MAIN_CRX_SIGNING_KEY_20261028:\s*\$\{\{\s*secrets\.MULTIPASS_MAIN_CRX_SIGNING_KEY_20261028\s*\}\}/);
assert.match(workflow, /node scripts\/publish-edge-addons\.mjs/);
assert.match(workflow, /EDGE_ADDONS_API_KEY:\s*\$\{\{\s*secrets\.EDGE_ADDONS_API_KEY\s*\}\}/);
assert.doesNotMatch(workflow, /vars\.EDGE_ADDONS_API_KEY/, 'the API key must never fall back to a plain Actions variable');
assert.doesNotMatch(workflow, /EDGE_ADDONS_PRODUCT_ID/, 'workflow must not depend on an unavailable product-ID variable');

const buildWorkflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/build-main-crx.yml'), 'utf8');
assert.match(buildWorkflow, /^on:\n  push:\n    branches:\n      - main\n  workflow_call:/m, 'every main push must build CRX and release jobs may reuse the build');
assert.match(buildWorkflow, /MULTIPASS_MAIN_CRX_SIGNING_KEY_20261028/);
assert.match(buildWorkflow, /MULTIPASS_MAIN_CRX_SIGNING_KEY_20261028:\n\s+required: true/);
assert.match(buildWorkflow, /hjkmgjalkohpaboeabhmjkidfbekmpda/);
assert.match(buildWorkflow, /scripts\/verify-crx3\.py/);
assert.match(buildWorkflow, /name: stable-id-crx-v\$\{\{ steps\.source\.outputs\.version \}\}/, 'main builds must use a concise versioned artifact name');
assert.match(buildWorkflow, /artifacts\/multipass-webdav-sync-v\$\{\{ steps\.source\.outputs\.version \}\}\.crx/, 'main builds must upload a concise versioned CRX filename');
assert.match(buildWorkflow, /EXTENSION_VERSION:\s*\$\{\{ steps\.source\.outputs\.version \}\}/, 'CRX filename version must come from the checked-out source');

const crxVerifier = fs.readFileSync(path.join(__dirname, '../scripts/verify-crx3.py'), 'utf8');
assert.match(crxVerifier, /expected_filename = f"multipass-webdav-sync-v\{expected_version\}\.crx"/, 'CRX verifier must enforce the short versioned filename');
assert.match(crxVerifier, /f"source_commit=\{source_sha\}\\n"/, 'build-info must retain the complete source commit hash');

const publisher = fs.readFileSync(path.join(__dirname, '../scripts/publish-edge-addons.mjs'), 'utf8');
assert.match(publisher, /Required encrypted GitHub Actions secret EDGE_ADDONS_API_KEY is unavailable/);
assert.match(publisher, /No API request was made/);

const metadataValidator = path.join(__dirname, '../scripts/validate-crx-metadata.cjs');
const metadataTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'crx-metadata-test-'));
const metadataCrx = path.join(metadataTemp, 'multipass-webdav-sync-v1.1.5.crx');
const metadataBytes = Buffer.from('offline-crx-fixture');
fs.writeFileSync(metadataCrx, metadataBytes);
const metadataSha = crypto.createHash('sha256').update(metadataBytes).digest('hex');
const metadataInfo = path.join(metadataTemp, 'build-info.txt');
fs.writeFileSync(metadataInfo, [
  'source_commit=0123456789abcdef0123456789abcdef01234567',
  'extension_version=1.1.5',
  'extension_id=hjkmgjalkohpaboeabhmjkidfbekmpda',
  'crx_file=multipass-webdav-sync-v1.1.5.crx',
  `crx_sha256=${metadataSha}`,
  'crx3_validated=true',
  'crx_signature_validated=true',
  '',
].join('\n'));
execFileSync(process.execPath, [metadataValidator, metadataInfo, metadataCrx, '0123456789abcdef0123456789abcdef01234567', '1.1.5', 'hjkmgjalkohpaboeabhmjkidfbekmpda']);
fs.writeFileSync(metadataInfo, fs.readFileSync(metadataInfo, 'utf8').replace('crx_signature_validated=true', 'crx_signature_validated=false'));
const invalidMetadata = spawnSync(process.execPath, [metadataValidator, metadataInfo, metadataCrx, '0123456789abcdef0123456789abcdef01234567', '1.1.5', 'hjkmgjalkohpaboeabhmjkidfbekmpda'], { encoding: 'utf8' });
assert.notEqual(invalidMetadata.status, 0);
assert.match(invalidMetadata.stderr, /CRX metadata validation failed/);

const attachStepMatch = workflow.match(/      - name: Attach versioned CRX to the published GitHub Release\n([\s\S]*?)(?=\n      - name:)/);
assert.ok(attachStepMatch, 'workflow must contain the CRX attachment step before store submission');
const attachStep = attachStepMatch[1];
assert.match(attachStep, /^          RELEASE_VERSION: \$\{\{ needs\.validate\.outputs\.version \}\}$/m, 'the attachment step itself must receive the validated version');
const attachRun = attachStep.match(/        run: \|\n([\s\S]*)/);
assert.ok(attachRun, 'attachment step must expose its shell for the runtime regression test');
const attachShell = attachRun[1].split('\n').map((line) => line.replace(/^ {10}/, '')).join('\n');
const shellTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'attach-shell-test-'));
const ghMarker = path.join(shellTemp, 'gh-called');
const fakeBin = path.join(shellTemp, 'bin');
fs.mkdirSync(fakeBin);
fs.writeFileSync(path.join(fakeBin, 'gh'), `#!/bin/sh\nprintf '%s\\n' "$@" > '${ghMarker}'\n`);
fs.chmodSync(path.join(fakeBin, 'gh'), 0o755);
const missingVersion = spawnSync('bash', ['-c', attachShell], {
  env: { PATH: `${fakeBin}:${process.env.PATH}`, RUNNER_TEMP: shellTemp, RELEASE_TAG: 'v1.1.5' },
  encoding: 'utf8',
});
assert.notEqual(missingVersion.status, 0, 'attach shell must reject a missing RELEASE_VERSION');
assert.equal(fs.existsSync(ghMarker), false, 'missing RELEASE_VERSION must fail before gh is called');
const shellCrx = path.join(shellTemp, 'release-crx', 'multipass-webdav-sync-v1.1.5.crx');
fs.mkdirSync(path.dirname(shellCrx));
fs.writeFileSync(shellCrx, 'offline-crx-fixture');
const validAttachment = spawnSync('bash', ['-c', attachShell], {
  env: { PATH: `${fakeBin}:${process.env.PATH}`, RUNNER_TEMP: shellTemp, RELEASE_TAG: 'v1.1.5', RELEASE_VERSION: '1.1.5' },
  encoding: 'utf8',
});
assert.equal(validAttachment.status, 0, validAttachment.stderr);
assert.deepEqual(fs.readFileSync(ghMarker, 'utf8').trim().split('\n'), ['release', 'upload', 'v1.1.5', shellCrx, '--clobber']);
fs.rmSync(shellTemp, { recursive: true, force: true });
fs.rmSync(metadataTemp, { recursive: true, force: true });

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
  'vendor/firefox-android/manifest.json': '1.2.3',
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
  { versions: { ...matchingVersions, 'vendor/firefox-android/manifest.json': '9.9.9' } },
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
