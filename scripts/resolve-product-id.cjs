'use strict';

function resolveProductId(suppliedProductId, allowlistedProductId) {
  if (typeof allowlistedProductId !== 'string' || !allowlistedProductId) {
    throw new Error('An allowlisted product ID is required by the publisher.');
  }

  const supplied = typeof suppliedProductId === 'string' ? suppliedProductId.trim() : '';
  if (supplied && supplied !== allowlistedProductId) {
    throw new Error('Configured product ID conflicts with the allowlisted existing product.');
  }
  return allowlistedProductId;
}

module.exports = { resolveProductId };
