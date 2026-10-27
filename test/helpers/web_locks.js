'use strict';

// Test-only origin-wide mutex. Production requires the browser's native Web Locks.
function createWebLocks() {
    var tails = Object.create(null);
    return {
        request: function(name, options, callback) {
            if(typeof options === 'function') { callback = options; options = {}; }
            if(typeof callback !== 'function') return Promise.reject(new TypeError('A lock callback is required.'));
            if(options && options.mode && options.mode !== 'exclusive') return Promise.reject(new Error('Test helper supports exclusive locks only.'));
            var previous = tails[name] || Promise.resolve();
            var operation = previous.then(function() { return callback({ name: name, mode: 'exclusive' }); });
            var released = operation.then(function() {}, function() {});
            tails[name] = released;
            released.then(function() { if(tails[name] === released) delete tails[name]; });
            return operation;
        }
    };
}
function installGlobalWebLocks(locks) {
    locks = locks || createWebLocks();
    Object.defineProperty(globalThis, 'navigator', { value: { locks: locks }, configurable: true, writable: true });
    return locks;
}
module.exports = { createWebLocks: createWebLocks, installGlobalWebLocks: installGlobalWebLocks };
