'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '../..');
const PUBLISHER = path.join(ROOT, 'scripts/publish-edge-addons.mjs');
const PRODUCT = '59f80db2-0cdb-44dc-9a9e-c723b24190e2';
const API = 'https://api.addons.microsoftedge.microsoft.com';
const API_KEY = 'dummy-api-key';
const CLIENT_ID = 'dummy-client-id';
const ZIP_BYTES = Buffer.from('dummy-zip-bytes-for-offline-test');

function dataModule(source) {
  return `data:text/javascript,${encodeURIComponent(source)}`;
}

function loaderSource() {
  return `
const publisher = ${JSON.stringify(`file://${PUBLISHER}`)};
const safeFetch = ${JSON.stringify(dataModule(strictMockSource()))};
const child = ${JSON.stringify(dataModule(childProcessSource()))};
const files = ${JSON.stringify(dataModule(fsSource()))};
const timers = ${JSON.stringify(dataModule(timersSource()))};
export async function resolve(specifier, context, nextResolve) {
  if (context.parentURL === publisher) {
    if (specifier === './safe-fetch.mjs') return { url: safeFetch, shortCircuit: true };
    if (specifier === 'node:child_process') return { url: child, shortCircuit: true };
    if (specifier === 'node:fs/promises') return { url: files, shortCircuit: true };
    if (specifier === 'node:timers/promises') return { url: timers, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
export async function load(url, context, nextLoad) {
  if ([safeFetch, child, files, timers].includes(url)) {
    return { format: 'module', source: decodeURIComponent(url.slice(url.indexOf(',') + 1)), shortCircuit: true };
  }
  return nextLoad(url, context);
}
`;
}

function strictMockSource() {
  return `
const API = ${JSON.stringify(API)};
const PRODUCT = ${JSON.stringify(PRODUCT)};
const KEY = ${JSON.stringify(API_KEY)};
const CLIENT = ${JSON.stringify(CLIENT_ID)};
const scenario = process.env.EDGE_MOCK_SCENARIO;
const version = process.env.RELEASE_VERSION;
const tag = process.env.RELEASE_TAG;
let calls = 0;
let uploadPolls = 0;
let submitPolls = 0;
const expectedUpload = '/v1/products/' + PRODUCT + '/submissions/draft/package';
const expectedUploadStatus = '/v1/products/' + PRODUCT + '/submissions/draft/package/operations/';
const expectedSubmit = '/v1/products/' + PRODUCT + '/submissions';
const expectedSubmitStatus = '/v1/products/' + PRODUCT + '/submissions/operations/';
function fail(message) { throw new Error('strict mock: ' + message); }
function headersOf(headers) {
  return Object.fromEntries(Object.entries(headers || {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
}
function checkHeaders(options, contentType) {
  const h = headersOf(options.headers);
  const expected = { authorization: 'ApiKey ' + KEY, 'x-clientid': CLIENT };
  if (contentType) expected['content-type'] = contentType;
  if (JSON.stringify(h) !== JSON.stringify(expected)) fail('unexpected headers');
}
function response(status, location, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get(name) { return name.toLowerCase() === 'location' ? location : null; } },
    async json() { return body; },
  };
}
export async function request(url, options, label) {
  calls += 1;
  const parsed = new URL(url);
  if (parsed.origin !== API) fail('unexpected origin');
  const method = options.method || 'GET';
  const body = options.body;
  if (scenario === 'missing-api-key') fail('request made despite missing API key');
  if (method === 'POST' && parsed.pathname === expectedUpload) {
    if (calls !== 1) fail('upload POST out of sequence');
    checkHeaders(options, 'application/zip');
    if (!Buffer.from(body).equals(Buffer.from(${JSON.stringify(ZIP_BYTES.toString('base64'))}, 'base64'))) fail('unexpected package bytes');
    const location = process.env.EDGE_MOCK_LOCATION || 'upload-operation';
    return response(202, location, {});
  }
  if (method === 'GET' && parsed.pathname.startsWith(expectedUploadStatus)) {
    checkHeaders(options, null);
    if (parsed.pathname !== expectedUploadStatus + encodeURIComponent('upload-operation') && parsed.pathname !== expectedUploadStatus + encodeURIComponent('upload.full')) fail('unexpected upload status path');
    uploadPolls += 1;
    if (scenario === 'upload-failed') return response(200, null, { status: 'Failed' });
    return response(200, null, { status: uploadPolls === 1 ? 'InProgress' : 'Succeeded' });
  }
  if (method === 'POST' && parsed.pathname === expectedSubmit) {
    if (scenario === 'upload-failed') fail('submit called after failed upload');
    if (calls < 3) fail('submit POST out of sequence');
    checkHeaders(options, 'application/json');
    if (options.body !== JSON.stringify({ notes: 'Automated submission for version ' + version + ' from tag ' + tag + '.' })) fail('unexpected submission notes');
    const location = process.env.EDGE_MOCK_SUBMIT_LOCATION || 'submit-operation';
    return response(202, location, {});
  }
  if (method === 'GET' && parsed.pathname.startsWith(expectedSubmitStatus)) {
    checkHeaders(options, null);
    if (parsed.pathname !== expectedSubmitStatus + encodeURIComponent('submit-operation') && parsed.pathname !== expectedSubmitStatus + encodeURIComponent('submit.full')) fail('unexpected submit status path');
    submitPolls += 1;
    return response(200, null, { status: scenario === 'submit-failed' ? 'Failed' : submitPolls === 1 ? 'InProgress' : 'Succeeded' });
  }
  fail('unknown call ' + method + ' ' + parsed.pathname);
}
process.on('exit', () => {
  const expected = scenario === 'upload-failed' ? 2 : scenario === 'bad-location' ? 1 : scenario === 'submit-failed' ? 5 : 6;
  if (scenario !== 'missing-api-key' && calls !== expected) process.stderr.write('strict mock call count mismatch\\n');
});
`;
}

function childProcessSource() {
  return `
const version = process.env.RELEASE_VERSION;
export function execFileSync(command, args, options) {
  if (command !== 'unzip') throw new Error('strict mock: unexpected executable');
  if (args[0] === '-tq') return Buffer.alloc(0);
  if (args[0] === '-p' && args[2] === 'manifest.json') return JSON.stringify({ version, manifest_version: 3 });
  if (args[0] === '-Z1') return 'manifest.json\\noptions.html\\npopin.html\\njs/extension.js\\n';
  throw new Error('strict mock: unexpected unzip arguments');
}
`;
}

function fsSource() {
  return `
export async function readFile(file) {
  if (file !== 'dist/chrome-multipass-' + process.env.RELEASE_VERSION + '.zip') throw new Error('strict mock: unexpected package path');
  return Buffer.from(${JSON.stringify(ZIP_BYTES.toString('base64'))}, 'base64');
}
`;
}

function timersSource() {
  return 'export function setTimeout() { return Promise.resolve(); }';
}

function runCase(temp, version, name, extraEnv = {}) {
  const env = {
    RELEASE_TAG: 'v' + version,
    RELEASE_VERSION: version,
    EDGE_ADDONS_API_KEY: API_KEY,
    EDGE_ADDONS_CLIENT_ID: CLIENT_ID,
    EDGE_MOCK_SCENARIO: name,
    ...extraEnv,
  };
  const result = spawnSync(process.execPath, ['--loader', path.join(temp, 'loader.mjs'), '--require', path.join(temp, 'preload.cjs'), PUBLISHER], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(result.stdout.includes(API_KEY), false, `${name}: stdout must not contain credentials`);
  assert.equal(result.stderr.includes(API_KEY), false, `${name}: stderr must not contain credentials`);
  return result;
}

async function runEdgeAddonsSubmissionMock() {
  const version = require(path.join(ROOT, 'package.json')).version;
  const manifestVersion = JSON.parse(fs.readFileSync(path.join(ROOT, 'vendor/common/manifest.json'), 'utf8')).version;
  assert.equal(manifestVersion, version, 'mock release version must follow package and manifest');
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'edge-addons-mock-'));
  try {
    await fsp.writeFile(path.join(temp, 'loader.mjs'), loaderSource());
    await fsp.writeFile(path.join(temp, 'preload.cjs'), "global.fetch = () => { throw new Error('unexpected direct fetch'); };\n");

    let result = runCase(temp, version, 'success', { EDGE_MOCK_LOCATION: 'upload-operation', EDGE_MOCK_SUBMIT_LOCATION: 'submit-operation' });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /strict mock call count mismatch/);
    assert.match(result.stdout, /Package upload operation succeeded\./);
    assert.match(result.stdout, /Certification submission operation succeeded\./);
    assert.match(result.stdout, /was submitted to Edge Add-ons certification/);

    for (const [uploadLocation, submitLocation] of [
      [API + '/v1/products/' + PRODUCT + '/submissions/draft/package/operations/upload.full', API + '/v1/products/' + PRODUCT + '/submissions/operations/submit.full'],
      ['/v1/products/' + PRODUCT + '/submissions/draft/package/operations/upload.full', '/v1/products/' + PRODUCT + '/submissions/operations/submit.full'],
      ['v1/products/' + PRODUCT + '/submissions/draft/package/operations/upload.full', 'v1/products/' + PRODUCT + '/submissions/operations/submit.full'],
    ]) {
      result = runCase(temp, version, 'success', { EDGE_MOCK_LOCATION: uploadLocation, EDGE_MOCK_SUBMIT_LOCATION: submitLocation });
      assert.equal(result.status, 0, result.stderr);
      assert.doesNotMatch(result.stderr, /strict mock call count mismatch/);
      assert.match(result.stdout, /was submitted to Edge Add-ons certification/);
    }

    result = runCase(temp, version, 'upload-failed');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Package upload operation failed/);
    assert.doesNotMatch(result.stderr, /strict mock|unexpected direct fetch/);
    assert.doesNotMatch(result.stdout, /Certification submission operation succeeded|was submitted to Edge Add-ons certification/);

    result = runCase(temp, version, 'submit-failed');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Certification submission operation failed/);
    assert.doesNotMatch(result.stderr, /strict mock|unexpected direct fetch/);
    assert.doesNotMatch(result.stdout, /was submitted to Edge Add-ons certification/);

    for (const location of [
      'https://evil.example/operation',
      API + '/v1/products/other/submissions/draft/package/operations/upload-operation',
      '/v1/products/' + PRODUCT + '/submissions/draft/package/operations/op?x=1',
      '/v1/products/' + PRODUCT + '/submissions/draft/package/operations/a%2Fb',
    ]) {
      result = runCase(temp, version, 'bad-location', { EDGE_MOCK_LOCATION: location });
      assert.equal(result.status, 1, `bad location should fail: ${location}`);
      assert.doesNotMatch(result.stderr, /strict mock|unexpected direct fetch/);
      assert.doesNotMatch(result.stdout, /Certification submission/);
    }

    result = runCase(temp, version, 'missing-api-key', { EDGE_ADDONS_API_KEY: '' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /No API request was made/);
    assert.doesNotMatch(result.stdout + result.stderr, /strict mock:|Package upload|Certification submission/);
  } finally {
    await fsp.rm(temp, { recursive: true, force: true });
  }
}

module.exports = { runEdgeAddonsSubmissionMock };
