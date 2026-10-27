'use strict';

var assert = require('assert');
if(!globalThis.crypto) globalThis.crypto = require('crypto').webcrypto;

var refuseSecretUse = false;
var testVault = {
    isUnlocked: function() { return true; },
    verifyUnlocked: function() { return refuseSecretUse ? Promise.reject(new Error('Vault is locked.')) : Promise.resolve(); },
    encrypt: function(value, kind) {
        return Promise.resolve({ format: 'multipass-vault-v1', kind: kind, parameters: { cipher: 'AES-GCM-256', kdf: 'PBKDF2-SHA256', iterations: 600000, saltBytes: 16, ivBytes: 12 }, salt: 'AAAAAAAAAAAAAAAAAAAAAA==', iv: 'AAAAAAAAAAAAAAAA', ciphertext: Buffer.from(JSON.stringify(value), 'utf8').toString('base64') });
    },
    decrypt: function(envelope) { return Promise.resolve(JSON.parse(Buffer.from(envelope.ciphertext, 'base64').toString('utf8'))); },
    getAsync: function(key, fallback) { return Promise.resolve(fallback); },
    setAsync: function() { return Promise.resolve(); },
    removeAsync: function() { return Promise.resolve(); }
};
require.cache[require.resolve('../js/vault')] = { id: require.resolve('../js/vault'), filename: require.resolve('../js/vault'), loaded: true, exports: testVault };
var Sync = require('../js/webdav_sync');

function rejects(promise, message) {
    return promise.then(function() {
        throw new Error('Expected the operation to reject: ' + message);
    }, function(error) {
        assert(error instanceof Error);
        if(message) assert(error.message.indexOf(message) !== -1, error.message);
    });
}

async function main() {
    assert.strictEqual(Sync.validateEndpoint('https://webdav.example.net/dav/multipass-sync.json'), 'https://webdav.example.net/dav/multipass-sync.json');
    ['http://localhost:8080/multipass-sync.json', 'http://127.0.0.1:8080/multipass-sync.json', 'http://[::1]:8080/multipass-sync.json', 'http://webdav.example.net/sync.json'].forEach(function(endpoint) {
        assert.throws(function() { Sync.validateEndpoint(endpoint); }, /HTTPS is required/);
    });
    assert.throws(function() { Sync.validateEndpoint('https://user:secret@webdav.example.net/sync.json'); }, /separate fields/);
    assert.throws(function() { Sync.validateEndpoint('https://webdav.example.net/sync.json?token=secret'); }, /URL query/);
    assert.throws(function() { Sync.validateEndpoint('https://webdav.example.net/sync.json#fragment'); }, /fragment/);

    var rejectedFetches = 0;
    var savedFetch = global.fetch;
    global.fetch = function() { rejectedFetches++; return Promise.reject(new Error('HTTP must not reach fetch')); };
    await rejects(Sync.readRemote({ endpoint: 'http://localhost/loopback', username: '', password: '' }), 'HTTPS is required');
    await rejects(Sync.putRemote({ endpoint: 'http://127.0.0.1/loopback', username: '', password: '' }, { format: 'fixture' }, ''), 'HTTPS is required');
    assert.strictEqual(rejectedFetches, 0, 'direct runtime calls must reject HTTP before fetch');
    refuseSecretUse = true;
    await rejects(Sync.readRemote({ endpoint: 'https://example.test/revoked', username: 'dummy', password: 'dummy' }), 'Vault is locked');
    assert.strictEqual(rejectedFetches, 0, 'durable revocation must block fetch even while a stale cached isUnlocked flag is true');
    refuseSecretUse = false;
    global.fetch = savedFetch;

    var common = {
        remoteExists: true,
        remoteEtag: '"same"',
        baselineEtag: '"same"',
        localFingerprint: 'local',
        baselineFingerprint: 'local',
        remoteRevision: 'revision-a',
        baselineRemoteRevision: 'revision-a',
        remoteUpdatedAt: 100,
        baselineRemoteUpdatedAt: 100,
        remoteDocumentHash: 'body-a',
        baselineRemoteDocumentHash: 'body-a'
    };
    assert.strictEqual(Sync.decideSync({ remoteExists: false, baselineEtag: '' }), 'create');
    assert.strictEqual(Sync.decideSync({ remoteExists: false, baselineEtag: '"old"' }), 'remote-deleted');
    assert.strictEqual(Sync.decideSync({ remoteExists: true, remoteEtag: '"new"', baselineEtag: '' }), 'first-connect');
    assert.strictEqual(Sync.decideSync({ remoteExists: true, remoteEtag: 'W/"weak"', baselineEtag: '"old"' }), 'missing-etag');
    assert.strictEqual(Sync.decideSync(Object.assign({}, common, { baselineFingerprint: '' })), 'first-connect');
    assert.strictEqual(Sync.decideSync(Object.assign({}, common, { baselineRemoteDocumentHash: '' })), 'first-connect');
    assert.strictEqual(Sync.decideSync(Object.assign({}, common, { localFingerprint: 'changed-local' })), 'push');
    assert.strictEqual(Sync.decideSync(Object.assign({}, common, { remoteEtag: '"new"', remoteRevision: 'revision-b', remoteDocumentHash: 'body-b' })), 'pull');
    assert.strictEqual(Sync.decideSync(Object.assign({}, common, { localFingerprint: 'changed-local', remoteEtag: '"new"', remoteRevision: 'revision-b', remoteDocumentHash: 'body-b' })), 'conflict');
    assert.strictEqual(Sync.decideSync(Object.assign({}, common, { remoteDocumentHash: 'body-tampered' })), 'etag-inconsistent', 'same strong ETag with a different body must stop');
    assert.strictEqual(Sync.decideSync(Object.assign({}, common, { remoteUpdatedAt: 101 })), 'etag-inconsistent');
    assert.strictEqual(Sync.decideSync(common), 'unchanged');

    var originalFetch = global.fetch;
    try {
        var requestOptions;
        global.fetch = function(url, options) {
            requestOptions = options;
            return Promise.resolve({ status: 201, ok: true, headers: { get: function(name) { return name === 'ETag' ? '"new"' : null; } } });
        };
        var source = {
            'https://admin.example.net/': {
                url: 'https://admin.example.net/', username: 'münchen', password: 'fixture-only-password', priority: 2
            }
        };
        var document = await Sync.createSyncDocument(source, 100);
    assert.deepStrictEqual(Object.keys(document).sort(), ['credentials','format','revision','schema','updatedAt'].sort(), 'sync documents must contain only the formal schema');
    await rejects(Sync.parseSyncDocument(Object.assign({}, document, { setVaultForTests: function() {} })), 'unknown fields');
        assert.strictEqual(document.format, 'multipass-webdav-sync-v2');
        assert.strictEqual(document.schema, 1);
        assert(document.updatedAt > 100);
        assert(JSON.stringify(document).includes('fixture-only-password'), 'the internal sync document contains credentials before encryption');
        assert.strictEqual(requestOptions, undefined);

        var parsed = await Sync.parseSyncDocument(JSON.parse(JSON.stringify(document)));
        assert.deepStrictEqual(JSON.parse(JSON.stringify(parsed.credentials)), {
            'https://admin.example.net/': {
                url: 'https://admin.example.net/', username: 'münchen', password: 'fixture-only-password', priority: '2'
            }
        });
        var tampered = JSON.parse(JSON.stringify(document));
        tampered.credentials['https://admin.example.net/'].password = 'changed';
        await rejects(Sync.parseSyncDocument(tampered), 'revision does not match');
        await rejects(Sync.parseSyncDocument({ format: 'multipass-webdav-encrypted-v1' }), 'legacy');
        await rejects(Sync.parseSyncDocument(Object.assign({}, document, { extra: true })), 'unknown fields');
        var extraCredentialField = JSON.parse(JSON.stringify(document));
        extraCredentialField.credentials['https://admin.example.net/'].token = 'unexpected';
        await rejects(Sync.parseSyncDocument(extraCredentialField), 'unknown credential fields');
        await rejects(Sync.parseSyncDocument(Object.assign({}, document, { credentials: [] })), 'invalid format');

        var etag = await Sync.putRemote({
            endpoint: 'https://webdav.example.net/file', username: 'münchen', password: 'dav-pass'
        }, document, '"old"');
        assert.strictEqual(etag, '"new"');
        assert.strictEqual(requestOptions.headers['Content-Type'], 'application/json; charset=utf-8');
        assert.strictEqual(Buffer.from(requestOptions.headers.Authorization.slice(6), 'base64').toString('utf8'), 'münchen:dav-pass');
        assert.strictEqual(requestOptions.headers['If-Match'], '"old"');
        var sentEnvelope = JSON.parse(requestOptions.body);
        assert.strictEqual(sentEnvelope.format, 'multipass-vault-v1');
        assert.strictEqual(sentEnvelope.kind, 'sync');
        assert(!requestOptions.body.includes('fixture-only-password'), 'the server body must not contain the site password in plaintext');

        global.fetch = function() {
            return Promise.resolve({ status: 204, ok: true, headers: { get: function() { return null; } } });
        };
        await rejects(Sync.putRemote({ endpoint: 'https://webdav.example.net/file' }, document, '"old"'), 'Sync status is unknown');

        global.fetch = function() {
            return Promise.resolve({ status: 412, ok: false, headers: { get: function() { return null; } } });
        };
        await rejects(Sync.putRemote({ endpoint: 'https://webdav.example.net/file' }, document, '"old"'), 'server rejected the conditional write');

        global.fetch = function() {
            return Promise.resolve({
                status: 200,
                ok: true,
                headers: { get: function(name) { return name === 'ETag' ? '"same"' : null; } },
                text: function() { return Promise.resolve('not-json'); }
            });
        };
        await rejects(Sync.readRemote({ endpoint: 'https://webdav.example.net/file' }), 'not valid JSON');

        var streamCancelled = false;
        global.fetch = function() {
            return Promise.resolve({
                status: 200,
                ok: true,
                headers: { get: function() { return null; } },
                body: {
                    getReader: function() {
                        return {
                            read: function() { return Promise.resolve({ done: false, value: new Uint8Array(5 * 1024 * 1024 + 1) }); },
                            cancel: function() { streamCancelled = true; return Promise.resolve(); }
                        };
                    }
                }
            });
        };
        await rejects(Sync.readRemote({ endpoint: 'https://webdav.example.net/file' }), '5 MB');
        assert.strictEqual(streamCancelled, true, 'oversized response streams must be cancelled immediately');

        var oversizedWriteFetched = false;
        global.fetch = function() { oversizedWriteFetched = true; return Promise.reject(new Error('should not fetch')); };
        await rejects(Sync.putRemote({ endpoint: 'https://webdav.example.net/file' }, { large: 'x'.repeat(5 * 1024 * 1024) }, ''), '5 MB');
        assert.strictEqual(oversizedWriteFetched, false, 'oversized local snapshots must be rejected before network access');

        global.fetch = function(url, options) {
            assert(options.signal, 'requests must carry an AbortSignal when supported');
            return new Promise(function(resolve, reject) { options.signal.addEventListener('abort', function() { var error = new Error('aborted'); error.name = 'AbortError'; reject(error); }); });
        };
        var oldTimeout = global.setTimeout;
        global.setTimeout = function(fn) { return oldTimeout(fn, 0); };
        await rejects(Sync.putRemote({ endpoint: 'https://webdav.example.net/file' }, document, '"old"'), 'may have been written');
        global.setTimeout = oldTimeout;
    } finally {
        global.fetch = originalFetch;
        if(oldTimeout) global.setTimeout = oldTimeout;
    }

    var originalChrome = global.chrome;
    var alarmState = {};
    global.chrome = {
        runtime: { lastError: null },
        alarms: {
            create: function(name, options) { alarmState[name] = options; },
            clear: function(name, callback) { delete alarmState[name]; if(callback) callback(true); }
        }
    };
    try {
        await Sync.configureAutoSyncAlarm(15);
        assert.strictEqual(alarmState['multipass-webdav-auto-sync'].periodInMinutes, 15);
        await Sync.configureAutoSyncAlarm(0);
        assert.strictEqual(Object.prototype.hasOwnProperty.call(alarmState, 'multipass-webdav-auto-sync'), false);
        await rejects(Sync.configureAutoSyncAlarm(-1), '0 to 10080');
    } finally {
        global.chrome = originalChrome;
    }

    console.log('WebDAV sync tests passed.');
}

var completed = false;
process.on('beforeExit', function() { if(!completed) { console.error('WebDAV test did not complete.'); process.exitCode = 1; } });
main().then(function() { completed = true; }, function(error) {
    completed = true;
    console.error(error.stack || error);
    process.exitCode = 1;
});
