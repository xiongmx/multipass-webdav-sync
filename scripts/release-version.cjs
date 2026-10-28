'use strict';

const STABLE_VERSION_TAG = /^v?((?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))$/;

function parseReleaseVersion(tag) {
  const match = STABLE_VERSION_TAG.exec(tag);
  return match ? match[1] : null;
}

function evaluatePublishedRelease({ eventName, eventAction, prerelease, tag, versions }) {
  if (eventName !== 'release' || eventAction !== 'published') {
    return { eligible: false, reason: 'Only a published GitHub Release can trigger publication.' };
  }
  if (prerelease !== false) {
    return { eligible: false, reason: 'Pre-releases are not eligible for store submission.' };
  }

  const version = parseReleaseVersion(tag || '');
  if (!version) {
    return { eligible: false, reason: 'Release tag is not a stable semantic version.' };
  }

  const mismatches = Object.entries(versions || {}).filter(([, actual]) => actual !== version);
  if (mismatches.length) {
    return {
      eligible: false,
      reason: `Release tag version ${version} does not match: ${mismatches.map(([name]) => name).join(', ')}.`,
    };
  }

  return { eligible: true, version, reason: 'Published stable release is eligible.' };
}

module.exports = { parseReleaseVersion, evaluatePublishedRelease };
