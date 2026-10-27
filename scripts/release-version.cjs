'use strict';

const STABLE_VERSION_TAG = /^v?((?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))$/;

function parseReleaseVersion(tag) {
  const match = STABLE_VERSION_TAG.exec(tag);
  return match ? match[1] : null;
}

module.exports = { parseReleaseVersion };
