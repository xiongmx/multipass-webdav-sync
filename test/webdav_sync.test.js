'use strict';

var assert = require('assert');
if(!globalThis.crypto) globalThis.crypto = require('crypto').webcrypto;

var refuseSecretUse = false;
var testVaultData = Object.create(null);
var testVault = {
    isUnlocked: function() { return true; },
    verifyUnlocked: function() { return refuseSecretUse ? Promise.reject(new Error('Vault is locked.')) : Promise.resolve(); },
    encrypt: function(value, kind) {
        return Promise.resolve({ format: 'multipass-vault-v1', kind: kind, parameters: { cipher: 'AES-GCM-256', kdf: 'PBKDF2-SHA256', iterations: 600000, saltBytes: 16, ivBytes: 12 }, salt: 'AAAAAAAAAAAAAAAAAAAAAA==', iv: 'AAAAAAAAAAAAAAAA', ciphertext: Buffer.from(JSON.stringify(value), 'utf8').toString('base64') });
    },
    decrypt: function(envelope) { return Promise.resolve(JSON.parse(Buffer.from(envelope.ciphertext, 'base64').toString('utf8'))); },
    getAsync: function(key, fallback) { return Promise.resolve(Object.prototype.hasOwnProperty.call(testVaultData, key) ? testVaultData[key] : fallback); },
    setAsync: function(key, value) { testVaultData[key] = value; return Promise.resolve(); },
    removeAsync: function(keys) {
        (Array.isArray(keys) ? keys : [keys]).forEach(function(key) { delete testVaultData[key]; });
        return Promise.resolve();
    },
    onLock: function() {},
    onUnlock: function() {}
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

function mockResponse(status, etag, body) {
    return {
        status: status,
        ok: status >= 200 && status < 300,
        headers: { get: function(name) { return name === 'ETag' ? (etag || null) : null; } },
        text: function() { return Promise.resolve(body); }
    };
}

async function assertReadbackFailure(syncDocument, etag, makeReadback, expectedMessage, putEtag) {
    var putCount = 0;
    var getCount = 0;
    var body;
    global.fetch = function(url, options) {
        if(options.method === 'PUT') {
            putCount++;
            body = options.body;
            return Promise.resolve(mockResponse(201, putEtag || null));
        }
        getCount++;
        return makeReadback(body);
    };
    await rejects(Sync.putRemote({ endpoint: 'https://webdav.example.net/file' }, syncDocument, etag), expectedMessage);
    assert.strictEqual(putCount, 1, 'an accepted PUT must never be repeated after uncertain read-back');
    assert.strictEqual(getCount, 1, 'an uncertain write must perform only the immediate verification GET');
}

function fakeElement(value) {
    return {
        value: value || '',
        checked: false,
        disabled: false,
        textContent: '',
        className: '',
        listeners: Object.create(null),
        addEventListener: function(name, callback) { this.listeners[name] = callback; }
    };
}

async function assertFailedManualPushDoesNotSaveBaseline(remoteExists, readbackFailure) {
    Object.keys(testVaultData).forEach(function(key) { delete testVaultData[key]; });
    var endpoint = 'https://webdav.example.net/file';
    testVaultData.multipassWebdavSettings = {
        endpoint: endpoint, username: '', password: '', autoSyncIntervalMinutes: 0, consentVersion: 1
    };
    testVaultData.multipassWebdavSyncMeta = {};
    var elements = {
        'webdav-status': fakeElement(),
        'webdav-pull': fakeElement(),
        'webdav-push': fakeElement(),
        'webdav-backup': fakeElement(),
        'webdav-save': fakeElement(),
        'webdav-sync': fakeElement(),
        'webdav-interval': fakeElement('0'),
        'webdav-url': fakeElement(endpoint),
        'webdav-username': fakeElement(''),
        'webdav-password': fakeElement(''),
        'webdav-consent': fakeElement()
    };
    elements['webdav-consent'].checked = true;
    global.document = { getElementById: function(id) { return elements[id] || null; } };
    global.window = { confirm: function() { return true; } };
    global.chrome = {
        runtime: { lastError: null },
        storage: { onChanged: { addListener: function() {} } },
        alarms: {
            create: function() { return Promise.resolve(); },
            clear: function(name, callback) { if(callback) callback(true); return Promise.resolve(true); },
            get: function(name, callback) { if(callback) callback(null); return Promise.resolve(null); }
        }
    };
    var localCredentials = {
        'https://local.example.net/': {
            url: 'https://local.example.net/', username: 'local-user', password: 'local-password', priority: '1'
        }
    };
    var oldDocument = await Sync.createSyncDocument({
        'https://remote.example.net/': {
            url: 'https://remote.example.net/', username: 'remote-user', password: 'remote-password', priority: '1'
        }
    }, Date.now() - 1000);
    var oldEnvelope = await testVault.encrypt(oldDocument, 'sync');
    var putCount = 0;
    var getCount = 0;
    var putBody = '';
    global.fetch = function(url, options) {
        if(options.method === 'PUT') {
            putCount++;
            putBody = options.body;
            return Promise.resolve(mockResponse(201, null));
        }
        getCount++;
        if(remoteExists && getCount === 1) return Promise.resolve(mockResponse(200, '"before-write"', JSON.stringify(oldEnvelope)));
        if(!remoteExists && getCount === 1) return Promise.resolve(mockResponse(404, null, ''));
        if(readbackFailure === 'mismatch') return Promise.resolve(mockResponse(200, '"after-write"', putBody + ' '));
        return Promise.resolve(mockResponse(503, null, ''));
    };
    Sync.init({ asJSON: function() { return JSON.stringify(localCredentials); } });
    elements['webdav-push'].listeners.click();
    await new Promise(function(resolve) { setTimeout(resolve, 10); });
    assert.strictEqual(putCount, 1, 'manual push must not repeat a PUT after an uncertain read-back');
    assert.strictEqual(getCount, 2, 'each push performs an initial read plus one follow-up verification GET');
    assert.deepStrictEqual(testVaultData.multipassWebdavSyncMeta, {}, 'an unconfirmed manual push must not create or advance a sync baseline');
    assert(elements['webdav-status'].textContent.indexOf('sync status is unknown') !== -1, elements['webdav-status'].textContent);
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
    assert.strictEqual(Sync.decideSync({ remoteExists: true, remoteEtag: null, baselineEtag: '' }), 'missing-etag');
    assert.strictEqual(Sync.decideSync({ remoteExists: true, remoteEtag: '*', baselineEtag: '' }), 'missing-etag', 'unquoted wildcard is not a strong entity tag');
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

        global.fetch = function() {
            return Promise.resolve({ status: 404, ok: false, headers: { get: function() { return null; } } });
        };
        var missingRemote = await Sync.readRemote({ endpoint: 'https://webdav.example.net/file' });
        assert.strictEqual(missingRemote.exists, false, '404 means the remote file is missing');

        var noEtagEnvelope = await testVault.encrypt(document, 'sync');
        global.fetch = function() {
            return Promise.resolve({
                status: 200,
                ok: true,
                headers: { get: function() { return null; } },
                text: function() { return Promise.resolve(JSON.stringify(noEtagEnvelope)); }
            });
        };
        var existingWithoutEtag = await Sync.readRemote({ endpoint: 'https://webdav.example.net/file' });
        assert.strictEqual(existingWithoutEtag.exists, true, 'a successful GET means the server reports an existing remote representation');
        assert.strictEqual(existingWithoutEtag.etag, null, 'the missing strong ETag remains distinguishable from a missing resource');

        var createPutBody;
        var createRequests = [];
        global.fetch = function(url, options) {
            createRequests.push(options.method);
            if(options.method === 'PUT') {
                requestOptions = options;
                createPutBody = options.body;
                return Promise.resolve(mockResponse(201, null));
            }
            return Promise.resolve(mockResponse(200, '"created-readback"', createPutBody));
        };
        var createEtag = await Sync.putRemote({ endpoint: 'https://webdav.example.net/file' }, document, '');
        assert.strictEqual(createEtag, '"created-readback"', 'a create-only PUT without ETag may proceed only with exact-body read-back and a strong ETag');
        assert.deepStrictEqual(createRequests, ['PUT', 'GET']);
        assert.strictEqual(requestOptions.headers['If-None-Match'], '*', 'a first push must use create-only If-None-Match');
        assert.strictEqual(Object.prototype.hasOwnProperty.call(requestOptions.headers, 'If-Match'), false, 'a first push must not send an unconditional or update write');

        var updatePutBody;
        var updateRequests = [];
        global.fetch = function(url, options) {
            updateRequests.push(options.method);
            if(options.method === 'PUT') {
                requestOptions = options;
                updatePutBody = options.body;
                return Promise.resolve(mockResponse(201, null));
            }
            return Promise.resolve(mockResponse(200, '"new-readback"', updatePutBody));
        };
        var etag = await Sync.putRemote({
            endpoint: 'https://webdav.example.net/file', username: 'münchen', password: 'dav-pass'
        }, document, '"old"');
        assert.strictEqual(etag, '"new-readback"', 'an existing-file PUT without ETag may proceed only with exact-body read-back and a strong ETag');
        assert.deepStrictEqual(updateRequests, ['PUT', 'GET']);
        assert.strictEqual(requestOptions.headers['Content-Type'], 'application/json; charset=utf-8');
        assert.strictEqual(Buffer.from(requestOptions.headers.Authorization.slice(6), 'base64').toString('utf8'), 'münchen:dav-pass');
        assert.strictEqual(requestOptions.headers['If-Match'], '"old"');
        var sentEnvelope = JSON.parse(requestOptions.body);
        assert.strictEqual(sentEnvelope.format, 'multipass-vault-v1');
        assert.strictEqual(sentEnvelope.kind, 'sync');
        assert(!requestOptions.body.includes('fixture-only-password'), 'the server body must not contain the site password in plaintext');

        var strongPutBody;
        global.fetch = function(url, options) {
            if(options.method === 'PUT') {
                strongPutBody = options.body;
                return Promise.resolve(mockResponse(201, '"put-etag"'));
            }
            return Promise.resolve(mockResponse(200, '"put-etag"', strongPutBody));
        };
        assert.strictEqual(await Sync.putRemote({ endpoint: 'https://webdav.example.net/file' }, document, '"old"'), '"put-etag"', 'a strong PUT ETag still requires exact read-back confirmation');

        await assertReadbackFailure(document, '', function(body) {
            return Promise.resolve(mockResponse(200, '"mismatch-create"', body + ' '));
        }, 'exactly match');
        await assertReadbackFailure(document, '"old"', function(body) {
            return Promise.resolve(mockResponse(200, '"mismatch-update"', body + ' '));
        }, 'exactly match');
        await assertReadbackFailure(document, '"old"', function(body) {
            return Promise.resolve(mockResponse(200, '"readback-etag"', body));
        }, 'did not match the PUT response', '"put-etag"');
        await assertReadbackFailure(document, '', function(body) {
            return Promise.resolve(mockResponse(200, 'W/"weak"', body));
        }, 'valid strong ETag');
        await assertReadbackFailure(document, '"old"', function(body) {
            return Promise.resolve(mockResponse(200, null, body));
        }, 'valid strong ETag');
        await assertReadbackFailure(document, '', function() {
            return Promise.resolve(mockResponse(500, null, ''));
        }, 'follow-up GET failed');
        await assertReadbackFailure(document, '"old"', function() {
            return Promise.reject(new Error('network unavailable'));
        }, 'follow-up GET failed');

        var invalidEtagFetched = false;
        global.fetch = function() { invalidEtagFetched = true; return Promise.reject(new Error('must not fetch')); };
        await rejects(Sync.putRemote({ endpoint: 'https://webdav.example.net/file' }, document, '*'), 'valid strong ETag');
        await rejects(Sync.putRemote({ endpoint: 'https://webdav.example.net/file' }, document, null), 'valid strong ETag');
        assert.strictEqual(invalidEtagFetched, false, 'an invalid existing-file validator must fail before any PUT');

        global.fetch = function() {
            return Promise.resolve({ status: 204, ok: true, headers: { get: function() { return null; } } });
        };
        await rejects(Sync.putRemote({ endpoint: 'https://webdav.example.net/file' }, document, '"old"'), 'sync status is unknown');

        global.fetch = function() {
            return Promise.resolve({ status: 412, ok: false, headers: { get: function() { return null; } } });
        };
        await rejects(Sync.putRemote({ endpoint: 'https://webdav.example.net/file' }, document, '"old"'), 'server rejected the conditional write');
        await rejects(Sync.putRemote({ endpoint: 'https://webdav.example.net/file' }, document, ''), 'initial read found no remote file');

        global.fetch = function(url, options) {
            assert.strictEqual(options.headers['If-None-Match'], '*');
            return Promise.resolve({ status: 501, ok: false, headers: { get: function() { return null; } } });
        };
        await rejects(Sync.putRemote({ endpoint: 'https://webdav.example.net/file' }, document, ''), 'No unconditional write was attempted');

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

    var savedFetchForPush = global.fetch;
    var savedChromeForPush = global.chrome;
    var savedDocumentForPush = global.document;
    var savedWindowForPush = global.window;
    try {
        await assertFailedManualPushDoesNotSaveBaseline(false, 'mismatch');
        await assertFailedManualPushDoesNotSaveBaseline(true, 'failed-get');
    } finally {
        global.fetch = savedFetchForPush;
        global.chrome = savedChromeForPush;
        if(typeof savedDocumentForPush === 'undefined') delete global.document; else global.document = savedDocumentForPush;
        if(typeof savedWindowForPush === 'undefined') delete global.window; else global.window = savedWindowForPush;
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
