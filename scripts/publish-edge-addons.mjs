import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

const API_ROOT = 'https://api.addons.microsoftedge.microsoft.com';
const ALLOWED_PRODUCT_ID = '59f80db2-0cdb-44dc-9a9e-c723b24190e2';
const OPERATION_TIMEOUT_MS = 10 * 60 * 1000;
const POLL_INTERVAL_MS = 10 * 1000;

function fail(message) {
  throw new Error(message);
}

function checkInputs() {
  const tag = process.env.RELEASE_TAG ?? '';
  const match = /^v?((?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))$/.exec(tag);
  if (!match) fail('Release tag is not a stable semantic version.');

  const version = process.env.RELEASE_VERSION ?? '';
  if (match[1] !== version) fail('Release tag and validated package version do not match.');

  const productId = (process.env.EDGE_ADDONS_PRODUCT_ID ?? '').trim();
  if (productId !== ALLOWED_PRODUCT_ID) {
    fail('Configured product ID is missing or does not match the allowlisted existing product.');
  }

  const apiKey = process.env.EDGE_ADDONS_API_KEY;
  const clientId = process.env.EDGE_ADDONS_CLIENT_ID;
  if (!apiKey) fail('Required GitHub Actions setting EDGE_ADDONS_API_KEY is unavailable.');
  if (!clientId) fail('Required GitHub Actions setting EDGE_ADDONS_CLIENT_ID is unavailable.');

  return { tag, version, apiKey, clientId, productId };
}

async function verifiedPackage(version) {
  const path = `dist/chrome-multipass-${version}.zip`;
  let archive;
  try {
    execFileSync('unzip', ['-tq', path], { stdio: 'ignore' });
    archive = execFileSync('unzip', ['-p', path, 'manifest.json'], { encoding: 'utf8' });
  } catch {
    fail(`Release package ${path} is missing, corrupt, or has no root manifest.json.`);
  }

  let manifest;
  try {
    manifest = JSON.parse(archive);
  } catch {
    fail('Release package manifest.json is not valid JSON.');
  }
  if (manifest.version !== version || manifest.manifest_version !== 3) {
    fail('Release package manifest version or Manifest V3 check failed.');
  }

  const names = execFileSync('unzip', ['-Z1', path], { encoding: 'utf8' })
    .split(/\r?\n/)
    .filter(Boolean);
  for (const required of ['manifest.json', 'options.html', 'popin.html', 'js/extension.js']) {
    if (!names.includes(required)) fail(`Release package is missing required file ${required}.`);
  }
  return path;
}

function authHeaders(apiKey, clientId) {
  return {
    Authorization: `ApiKey ${apiKey}`,
    'X-ClientID': clientId,
  };
}

async function request(url, options, label) {
  let response;
  try {
    response = await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    fail(`${label} request failed before an HTTP response; it was not retried.`);
  }
  if (!response.ok) fail(`${label} was rejected with HTTP ${response.status}; the response body was not logged.`);
  return response;
}

function operationIdFromLocation(location, productId, statusPath) {
  if (!location) fail('Microsoft API response did not include the documented Location header.');

  let url;
  try {
    url = new URL(location, API_ROOT);
  } catch {
    fail('Microsoft API returned an invalid operation Location.');
  }
  const prefix = statusPath;
  if (url.origin !== API_ROOT || !url.pathname.startsWith(prefix)) {
    fail('Microsoft API returned an unexpected operation Location; no credentials were sent to it.');
  }
  const operationId = decodeURIComponent(url.pathname.slice(prefix.length));
  if (!operationId || operationId.includes('/') || !/^[A-Za-z0-9._-]+$/.test(operationId)) {
    fail('Microsoft API returned an invalid operation ID.');
  }
  return operationId;
}

async function waitForOperation(operationId, statusPath, headers, label) {
  const url = `${API_ROOT}${statusPath}${encodeURIComponent(operationId)}`;
  const deadline = Date.now() + OPERATION_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const response = await request(url, { method: 'GET', headers }, `${label} status check`);
    let result;
    try {
      result = await response.json();
    } catch {
      fail(`${label} status response was not valid JSON.`);
    }

    if (result.status === 'Succeeded') {
      console.log(`${label} operation succeeded.`);
      return;
    }
    if (result.status === 'Failed') fail(`${label} operation failed; Microsoft response details were not logged.`);

    await delay(POLL_INTERVAL_MS);
  }
  fail(`${label} operation did not reach a terminal state within 10 minutes; it was not retried.`);
}

async function main() {
  const { tag, version, apiKey, clientId, productId } = checkInputs();
  const packagePath = await verifiedPackage(version);
  const headers = authHeaders(apiKey, clientId);

  const packageBytes = await readFile(packagePath);
  const uploadUrl = `${API_ROOT}/v1/products/${productId}/submissions/draft/package`;
  const upload = await request(uploadUrl, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/zip' },
    body: packageBytes,
  }, 'Package upload');
  if (upload.status !== 202) fail(`Package upload returned HTTP ${upload.status}; expected 202 Accepted.`);
  const uploadStatusPath = `/v1/products/${productId}/submissions/draft/package/operations/`;
  const uploadOperation = operationIdFromLocation(upload.headers.get('location'), productId, uploadStatusPath);
  await waitForOperation(uploadOperation, uploadStatusPath, headers, 'Package upload');

  const submitUrl = `${API_ROOT}/v1/products/${productId}/submissions`;
  const submission = await request(submitUrl, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ notes: `Automated submission for version ${version} from tag ${tag}.` }),
  }, 'Certification submission');
  if (submission.status !== 202) fail(`Certification submission returned HTTP ${submission.status}; expected 202 Accepted.`);
  const submitStatusPath = `/v1/products/${productId}/submissions/operations/`;
  const submitOperation = operationIdFromLocation(submission.headers.get('location'), productId, submitStatusPath);
  await waitForOperation(submitOperation, submitStatusPath, headers, 'Certification submission');

  console.log(`Version ${version} was submitted to Edge Add-ons certification for the existing product.`);
}

main().catch((error) => {
  console.error(`Edge Add-ons release failed: ${error instanceof Error ? error.message : 'unexpected error'}`);
  process.exitCode = 1;
});
