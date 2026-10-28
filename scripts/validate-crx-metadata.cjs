'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const [infoPath, crxPath, expectedSource, expectedVersion, expectedExtensionId] = process.argv.slice(2);

function fail(message) {
  throw new Error(`CRX metadata validation failed: ${message}`);
}

if (!infoPath || !crxPath || !expectedSource || !expectedVersion || !expectedExtensionId) {
  fail('usage: node scripts/validate-crx-metadata.cjs <build-info> <crx> <source-sha> <version> <extension-id>');
}
if (!/^[0-9a-f]{40}$/.test(expectedSource)) fail('expected source commit must be a complete SHA-1');
if (!/^\d+\.\d+\.\d+$/.test(expectedVersion)) fail('expected version must be stable semver');

let info;
try {
  info = Object.fromEntries(fs.readFileSync(infoPath, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => {
    const separator = line.indexOf('=');
    if (separator <= 0) fail(`malformed metadata line: ${line}`);
    return [line.slice(0, separator), line.slice(separator + 1)];
  }));
} catch (error) {
  if (error instanceof Error && error.message.startsWith('CRX metadata validation failed:')) throw error;
  fail(`cannot read ${infoPath}`);
}

let crx;
try {
  crx = fs.readFileSync(crxPath);
} catch {
  fail(`cannot read ${crxPath}`);
}
const actualSha256 = crypto.createHash('sha256').update(crx).digest('hex');
const expectedFilename = `multipass-webdav-sync-v${expectedVersion}.crx`;
const expected = {
  source_commit: expectedSource,
  extension_version: expectedVersion,
  extension_id: expectedExtensionId,
  crx_file: expectedFilename,
  crx_sha256: actualSha256,
  crx3_validated: 'true',
  crx_signature_validated: 'true',
};
for (const [key, value] of Object.entries(expected)) {
  if (info[key] !== value) fail(`${key} does not match expected value`);
}
if (path.basename(crxPath) !== expectedFilename) fail(`file is named ${path.basename(crxPath)}, expected ${expectedFilename}`);

console.log(`Validated build metadata for ${expectedFilename} from ${expectedSource}.`);
