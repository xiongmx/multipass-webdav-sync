'use strict';

/*
 * This is deliberately a two-page test.  Each page has its own CommonJS
 * module graph (including its own Vault and CredentialStorage singleton), but
 * both pages use the same extension storage and session objects.
 */
var assert = require('assert');
var fs = require('fs');
var path = require('path');
var vm = require('vm');
var webcrypto = require('crypto').webcrypto;

var ROOT = process.env.CREDENTIAL_CONCURRENCY_SOURCE_DIR || path.resolve(__dirname, '..');
var localData = Object.create(null), sessionData = Object.create(null);
var listeners = [], runtime = { lastError: null };
var lockQueue = Promise.resolve(), lockCalls = 0;
var heldCredentialWrites = [], holdCredentialWrites = false;
var credentialWriteCount = 0;

function clone(value) {
    if(value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
}
function emit(changes, area) {
    listeners.slice().forEach(function(listener) { listener(clone(changes), area); });
}
function asyncCallback(callback, value) { setImmediate(function() { callback(value); }); }
function store(data, area) {
    return {
        get: function(keys, callback) {
            var names = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(data);
            var result = {};
            names.forEach(function(key) {
                if(Object.prototype.hasOwnProperty.call(data, key)) result[key] = clone(data[key]);
            });
            asyncCallback(callback, result);
        },
        set: function(values, callback) {
            var changes = {}, isCredentialWrite = area === 'local' &&
                Object.prototype.hasOwnProperty.call(values, 'credentials');
            Object.keys(values).forEach(function(key) {
                changes[key] = { oldValue: clone(data[key]), newValue: clone(values[key]) };
                data[key] = clone(values[key]);
            });
            if(isCredentialWrite) credentialWriteCount++;
            var finish = function() { emit(changes, area); asyncCallback(callback); };
            if(isCredentialWrite && holdCredentialWrites && !lockCalls) heldCredentialWrites.push(finish);
            else finish();
        },
        remove: function(keys, callback) {
            var changes = {};
            (Array.isArray(keys) ? keys : [keys]).forEach(function(key) {
                changes[key] = { oldValue: clone(data[key]) };
                delete data[key];
            });
            emit(changes, area);
            asyncCallback(callback);
        },
        setAccessLevel: function() { return Promise.resolve(); }
    };
}
var sharedChrome = {
    runtime: runtime,
    storage: {
        local: store(localData, 'local'),
        session: store(sessionData, 'session'),
        onChanged: { addListener: function(listener) { listeners.push(listener); } }
    }
};

/* A real queue-shaped Web Locks implementation, shared by both page globals. */
var sharedLocks = {
    request: function(name, options, callback) {
        if(typeof options === 'function') callback = options;
        assert.strictEqual(name, 'multipass-vault:storage');
        lockCalls++;
        var run = lockQueue.then(function() { return callback({ name: name }); });
        lockQueue = run.then(function() {}, function() {});
        return run;
    }
};

function resolveModule(request, parent) {
    if(request.charAt(0) !== '.') return require.resolve(request);
    return require.resolve(path.resolve(path.dirname(parent), request));
}
function page(withLocks) {
    var cache = Object.create(null);
    var context = vm.createContext({
        chrome: sharedChrome,
        crypto: webcrypto,
        TextEncoder: TextEncoder,
        TextDecoder: TextDecoder,
        Uint8Array: Uint8Array,
        URL: URL,
        Promise: Promise,
        setImmediate: setImmediate,
        setTimeout: setTimeout,
        clearTimeout: clearTimeout,
        btoa: function(value) { return Buffer.from(value, 'binary').toString('base64'); },
        atob: function(value) { return Buffer.from(value, 'base64').toString('binary'); },
        navigator: withLocks ? { locks: sharedLocks } : {}
    });
    function load(filename) {
        filename = require.resolve(filename);
        if(cache[filename]) return cache[filename].exports;
        var module = { exports: {} };
        cache[filename] = module;
        var source = fs.readFileSync(filename, 'utf8');
        var wrapped = vm.runInContext('(function(require,module,exports,__filename,__dirname){\n' + source + '\n})', context, { filename: filename });
        function localRequire(request) { return load(resolveModule(request, filename)); }
        wrapped(localRequire, module, module.exports, filename, path.dirname(filename));
        return module.exports;
    }
    return { CredentialStorage: load(path.join(ROOT, 'js/credential_storage.js')),
        Storage: load(path.join(ROOT, 'js/storage.js')), Vault: load(path.join(ROOT, 'js/vault.js')), context: context };
}

function timeout(promise, label, ms) {
    return new Promise(function(resolve, reject) {
        var timer = setTimeout(function() { reject(new Error('Timed out: ' + label)); }, ms || 10000);
        Promise.resolve(promise).then(function(value) { clearTimeout(timer); resolve(value); }, function(error) { clearTimeout(timer); reject(error); });
    });
}
function equalJSON(actual, expected, message) {
    assert.deepStrictEqual(JSON.parse(JSON.stringify(actual)), expected, message);
}
function sorted(value) {
    return Object.keys(value).sort().map(function(key) { return value[key]; });
}
function rawCredentials(pageObject) {
    return pageObject.Storage.getAsync('credentials', {}).then(function(value) {
        return value || {};
    });
}
function waitForRaw(pageObject, expected) {
    return timeout(rawCredentials(pageObject).then(function(value) {
        equalJSON(value, expected, 'Actual persisted/decrypted credentials must contain every successful update');
        return value;
    }), 'AEAD storage readback');
}
function closeWriteGate() {
    holdCredentialWrites = false;
    var pending = heldCredentialWrites.splice(0);
    pending.forEach(function(finish) { finish(); });
}
function inPage(pageObject, value) {
    return vm.runInContext('JSON.parse(' + JSON.stringify(JSON.stringify(value)) + ')', pageObject.context);
}

var BASE = [
    { url: '^https://base.example/', username: 'base-user', password: 'test-only-base', priority: 1 }
];
var ADD_A = { url: '^https://a.example/', username: 'a-user', password: 'test-only-a', priority: 2 };
var ADD_B = { url: '^https://b.example/', username: 'b-user', password: 'test-only-b', priority: 3 };
var EDITED = { url: '^https://base.example/', username: 'edited-user', password: 'test-only-edited', priority: 4 };
var BATCH_A = { url: '^https://batch-a.example/', username: 'batch-a', password: 'test-only-batch-a', priority: 5 };
var BATCH_B = { url: '^https://batch-b.example/', username: 'batch-b', password: 'test-only-batch-b', priority: 6 };

async function main() {
    var pageA = page(true), pageB = page(true);
    assert.notStrictEqual(pageA.CredentialStorage, pageB.CredentialStorage,
        'pages must not share the CredentialStorage singleton');
    assert.notStrictEqual(pageA.Storage, pageB.Storage, 'pages must not share the Storage module');

    var phrase = 'test-only vault passphrase';
    var vaultA = pageA.CredentialStorage;
    assert.notStrictEqual(pageA.Vault, pageB.Vault, 'pages must not share the Vault singleton');
    await timeout(Promise.all([pageA.Vault.ready(), pageB.Vault.ready()]), 'initial module setup');
    await timeout(pageA.Vault.create(phrase), 'vault creation');
    await timeout(Promise.all([pageA.CredentialStorage.ready(), pageB.CredentialStorage.ready()]), 'page unlock propagation');

    async function reset() {
        closeWriteGate();
        await timeout(pageA.CredentialStorage.replaceAll(inPage(pageA, BASE)), 'reset base');
        await waitForRaw(pageA, { 'url:^https://base.example/': BASE[0] });
        await waitForRaw(pageB, { 'url:^https://base.example/': BASE[0] });
    }
    async function concurrent(label, operationA, operationB, expected) {
        await reset();
        var beforeLocks = lockCalls;
        credentialWriteCount = 0;
        holdCredentialWrites = true;
        var jobs = [operationA(), operationB()];
        /* Old per-module queues may reach the storage callback at different
         * times; release after a bounded overlap window rather than waiting
         * forever for a second callback.  With Web Locks, writes are not held. */
        setTimeout(function() { if(holdCredentialWrites) closeWriteGate(); }, 100);
        var all = Promise.all(jobs);
        await timeout(all, label + ' operations');
        closeWriteGate();
        await waitForRaw(pageA, expected);
        await waitForRaw(pageB, expected);
        assert(lockCalls > beforeLocks, label + ' must use the shared Web Locks name');
        assert(credentialWriteCount >= 2, label + ' must persist both successful operations');
        console.log(label + ': both independent VM readbacks retain ' + Object.keys(expected).length + ' rules.');
        return Promise.all([rawCredentials(pageA), rawCredentials(pageB)]);
    }

    await concurrent('add/add', function() { return vaultA.addCredential(inPage(pageA, ADD_A)); },
        function() { return pageB.CredentialStorage.addCredential(inPage(pageB, ADD_B)); },
        { 'url:^https://base.example/': BASE[0], 'url:^https://a.example/': ADD_A, 'url:^https://b.example/': ADD_B });
    await concurrent('edit/add', function() { return vaultA.saveCredential(inPage(pageA, EDITED), BASE[0].url); },
        function() { return pageB.CredentialStorage.addCredential(inPage(pageB, ADD_B)); },
        { 'url:^https://base.example/': EDITED, 'url:^https://b.example/': ADD_B });
    await concurrent('remove/add', function() { return vaultA.removeCredential(BASE[0].url); },
        function() { return pageB.CredentialStorage.addCredential(inPage(pageB, ADD_B)); },
        { 'url:^https://b.example/': ADD_B });
    await concurrent('batch-import/add', function() { return vaultA.addCredentials(inPage(pageA, [BATCH_A, BATCH_B])); },
        function() { return pageB.CredentialStorage.addCredential(inPage(pageB, ADD_B)); },
        { 'url:^https://base.example/': BASE[0], 'url:^https://batch-a.example/': BATCH_A,
            'url:^https://batch-b.example/': BATCH_B, 'url:^https://b.example/': ADD_B });

    var noLocks = page(false);
    await timeout(noLocks.CredentialStorage.ready(), 'no-WebLocks page ready');
    await assert.rejects(noLocks.CredentialStorage.addCredential(inPage(noLocks, {
        url: '^https://no-locks.example/', username: 'none', password: 'test-only-no-locks', priority: 9
    })), /Web Locks|lock/i, 'writes must fail closed when Web Locks are unavailable');
    assert.strictEqual(await rawCredentials(pageA).then(function(v) { return Object.prototype.hasOwnProperty.call(v, 'url:^https://no-locks.example/'); }), false);
    console.log('Credential concurrency tests passed: independent VM pages, AEAD readback, four interleavings, shared Web Locks, and fail-closed no-lock platform.');
}

var completed = false;
process.on('beforeExit', function() { if(!completed) { console.error('Credential concurrency test did not complete.'); process.exitCode = 1; } });
main().then(function() { completed = true; }, function(error) { completed = true; console.error(error.stack || error); process.exitCode = 1; });
