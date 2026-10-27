'use strict';

var assert = require('assert');
var path = require('path');

var root = path.resolve(__dirname, '..');
var policyPath = require.resolve(path.join(root, 'js/auth_policy'));
var storagePath = require.resolve(path.join(root, 'js/storage'));
var credentialPath = require.resolve(path.join(root, 'js/credential_storage'));
var webdavPath = require.resolve(path.join(root, 'js/webdav_sync'));
var extensionPath = require.resolve(path.join(root, 'js/extension'));
var vaultPath = require.resolve(path.join(root, 'js/vault'));
var vaultLocked = false, vaultRevoked = false, vaultLockCallbacks = [], vaultUnlockCallbacks = [];
var mockVault = {
    constants: { encryptedValuesKey: 'vaultEncryptedValues', configKey: 'vaultConfig' },
    ready: function() { return Promise.resolve(); },
    verifyUnlocked: function() { return (vaultLocked || vaultRevoked) ? Promise.reject(new Error('Vault is locked.')) : Promise.resolve(); },
    isUnlocked: function() { return !vaultLocked; },
    onLock: function(cb) { vaultLockCallbacks.push(cb); return function() {}; },
    onUnlock: function(cb) { vaultUnlockCallbacks.push(cb); return function() {}; },
    getAsync: function(key, fallback) { if(vaultLocked) return Promise.reject(new Error('Vault is locked.')); return Promise.resolve(Object.prototype.hasOwnProperty.call(mockVault.values, key) ? mockVault.values[key] : fallback); },
    setAsync: function(key, value) { if(vaultLocked) return Promise.reject(new Error('Vault is locked.')); mockVault.values[key] = value; return Promise.resolve(); },
    updateAsync: function(key, fallback, updater) { return mockVault.getAsync(key, fallback).then(updater).then(function(next) { return mockVault.setAsync(key, next).then(function() { return next; }); }); },
    values: {}
};

function clearModules() {
    [extensionPath, credentialPath, storagePath, webdavPath, policyPath].forEach(function(modulePath) {
        delete require.cache[modulePath];
    });
}

function makeChrome(initialCredentials) {
    var values = { credentials: initialCredentials || {} };
    var listeners = [];
    var completedListeners = [];
    var storageChanges = [];
    var authCalls = [];
    var completedCalls = [];
    var chrome = {
        runtime: {
            lastError: null,
            getManifest: function() { return { manifest_version: 3 }; }
        },
        action: {
            setBadgeText: function() {},
            setBadgeBackgroundColor: function() {}
        },
        storage: {
            local: {
                get: function(key, callback) {
                    var result = {};
                    result[key] = values[key];
                    callback(result);
                },
                set: function(update, callback) {
                    Object.keys(update).forEach(function(key) {
                        var oldValue = values[key];
                        values[key] = update[key];
                        storageChanges.push({ key: key, oldValue: oldValue, newValue: values[key] });
                    });
                    callback();
                }
            },
            onChanged: { addListener: function() {} }
        },
        webRequest: {
            onAuthRequired: {
                addListener: function(callback, filter, extraInfoSpec) {
                    authCalls.push({ callback: callback, filter: filter, extraInfoSpec: extraInfoSpec });
                    listeners.push(callback);
                }
            },
            onCompleted: {
                addListener: function(callback, filter) {
                    completedCalls.push({ callback: callback, filter: filter });
                    completedListeners.push(callback);
                }
            }
        },
        tabs: {
            onUpdated: { addListener: function() {} },
            onActivated: { addListener: function() {} },
            get: function(tabId, callback) { callback({ id: tabId, url: 'https://example.test/' }); }
        }
    };
    chrome.__state = {
        values: values,
        listeners: listeners,
        completedListeners: completedListeners,
        authCalls: authCalls,
        completedCalls: completedCalls,
        storageChanges: storageChanges
    };
    return chrome;
}

async function main() {
    var originalChrome = global.chrome;
    var originalWindow = global.window;
    var chrome = makeChrome();
    global.chrome = chrome;
    global.window = {};
    mockVault.values = chrome.__state.values;
    vaultLocked = false;
    require.cache[vaultPath] = { id: vaultPath, filename: vaultPath, loaded: true, exports: mockVault };
    clearModules();

    try {
        var policy = require(policyPath);
        assert.strictEqual(policy.DEFAULT_RULE, '^https://');
        assert.strictEqual(policy.isHttpsUrl('https://example.test/path'), true);
        [
            'http://example.test/path',
            'http://localhost:8080/path',
            'http://127.0.0.1/path',
            'http://[::1]/path',
            'ftp://example.test/path',
            'httpsx://example.test/path',
            'xhttps://example.test/path',
            'https://example.test@http://evil.test/',
            'not a URL',
            '',
            null,
            undefined
        ].forEach(function(url) {
            assert.strictEqual(policy.isHttpsUrl(url), false, 'must reject URL: ' + String(url));
        });
        assert.strictEqual(policy.matchesRule('^https://secure\\.test/', 'https://secure.test/path'), true);
        assert.strictEqual(policy.matchesRule('.*', 'http://localhost:8080/path'), false);
        assert.strictEqual(policy.matchesRule('[', 'https://secure.test/path'), false);
        assert.doesNotThrow(function() { policy.matchesRule('[', 'https://secure.test/path'); });

        var eligible = { url: 'https://secure.test/path', scheme: 'BaSiC', isProxy: false };
        assert.strictEqual(policy.isEligibleChallenge(eligible), true);
        assert.strictEqual(policy.isEligibleChallenge({ url: 'http://secure.test/path', scheme: 'basic', isProxy: false }), false);
        assert.strictEqual(policy.isEligibleChallenge({ url: 'https://secure.test/path', scheme: 'digest', isProxy: false }), false);
        assert.strictEqual(policy.isEligibleChallenge({ url: 'https://secure.test/path', scheme: 'basic', isProxy: true }), false);
        ['url', 'scheme', 'isProxy'].forEach(function(field) {
            var missing = { url: eligible.url, scheme: eligible.scheme, isProxy: eligible.isProxy };
            delete missing[field];
            assert.strictEqual(policy.isEligibleChallenge(missing), false, 'missing ' + field + ' must fail closed');
        });
        assert.strictEqual(policy.isEligibleChallenge({ url: 'https://secure.test/path', scheme: 'basic', isProxy: 0 }), false);

        var CredentialStorage = require(credentialPath);
        await CredentialStorage.replaceAll([
            { url: '^https://secure\\.test/', username: 'alice', password: 'secret', priority: 1 },
            { url: '.*', username: 'broad', password: 'must-not-leak', priority: 2 }
        ]);
        assert.strictEqual(CredentialStorage.getCredentials({ url: 'http://example.test/path' }).length, 0);
        assert.strictEqual(CredentialStorage.getCredentials({ url: 'http://localhost:8080/path' }).length, 0);
        assert.strictEqual(CredentialStorage.getCredentials({ url: 'http://127.0.0.1/path' }).length, 0);
        assert.strictEqual(CredentialStorage.getCredentials({ url: 'http://[::1]/path' }).length, 0);
        assert.strictEqual(CredentialStorage.getCredentials({ url: 'httpsx://secure.test/path' }).length, 0);
        assert.doesNotThrow(function() {
            assert.deepStrictEqual(CredentialStorage.getCredentials({ url: 'not a URL' }), []);
            assert.deepStrictEqual(CredentialStorage.getCredentials({}), []);
        });
        assert.strictEqual(CredentialStorage.getCredentials({ url: 'https://secure.test/path' })[0].username, 'alice');
        assert.strictEqual(CredentialStorage.getCredential('^https\\.test/'), null);
        assert.strictEqual(CredentialStorage.getCredential('^https://secure\\.test/').password, 'secret');
        var webdavStub = { initBackground: function() { return Promise.resolve(); } };
        require.cache[webdavPath] = { id: webdavPath, filename: webdavPath, loaded: true, exports: webdavStub };
        require(extensionPath);
        assert.strictEqual(chrome.__state.authCalls.length, 1);
        assert.strictEqual(chrome.__state.completedCalls.length, 1);
        assert.deepStrictEqual(chrome.__state.authCalls[0].filter, { urls: ['https://*/*'] });
        assert.deepStrictEqual(chrome.__state.completedCalls[0].filter, { urls: ['https://*/*'] });
        assert.strictEqual(chrome.__state.authCalls[0].filter.urls.indexOf('<all_urls>'), -1);
        assert.strictEqual(chrome.__state.completedCalls[0].filter.urls.indexOf('<all_urls>'), -1);

        assert.deepStrictEqual(chrome.__state.authCalls[0].extraInfoSpec, ['asyncBlocking']);
        var listener = chrome.__state.authCalls[0].callback;
        function auth(status) { return new Promise(function(resolve) { listener(status, resolve); }); }
        assert.deepStrictEqual(await auth({ url: 'https://secure.test/path', scheme: 'basic', isProxy: false, tabId: 1, requestId: 'https-1' }), {
            authCredentials: { username: 'alice', password: 'secret' }
        });
        assert.deepStrictEqual(await auth({ url: 'http://example.test/path', scheme: 'basic', isProxy: false, tabId: 1, requestId: 'http-1' }), {});
        assert.deepStrictEqual(await auth({ url: 'https://secure.test/path', scheme: 'basic', isProxy: true, tabId: 1, requestId: 'proxy-1' }), {});
        assert.deepStrictEqual(await auth({ url: 'https://secure.test/path', scheme: 'digest', isProxy: false, tabId: 1, requestId: 'digest-1' }), {});
        assert.deepStrictEqual(await auth({ url: 'https://secure.test/path', scheme: 'basic', tabId: 1, requestId: 'missing-proxy-1' }), {});
        assert.deepStrictEqual(await auth({ url: 'https://secure.test/path', isProxy: false, tabId: 1, requestId: 'missing-scheme-1' }), {});
        assert.deepStrictEqual(await auth({ scheme: 'basic', isProxy: false, tabId: 1, requestId: 'missing-url-1' }), {});
        vaultRevoked = true;
        assert.strictEqual(mockVault.isUnlocked(), true, 'fixture must retain a stale local unlocked flag');
        assert.deepStrictEqual(await auth({ url: 'https://secure.test/path', scheme: 'basic', isProxy: false, tabId: 1, requestId: 'durably-revoked-1' }), {}, 'durable revocation must block credentials before local onChanged arrives');
        vaultRevoked = false;
        vaultLocked = true;
        vaultLockCallbacks.slice().forEach(function(callback) { callback(); });
        assert.deepStrictEqual(CredentialStorage.getCredentials({ url: 'https://secure.test/path' }), []);
        assert.deepStrictEqual(await auth({ url: 'https://secure.test/path', scheme: 'basic', isProxy: false, tabId: 1, requestId: 'locked-1' }), {});
        assert.strictEqual(CredentialStorage.getCredential('^https://secure\\.test/'), null);
        await assert.rejects(CredentialStorage.addCredential({ url: '^https://locked.test/', username: 'u', password: 'p' }), /locked/);

        console.log('HTTPS auth policy tests passed.');
    } finally {
        clearModules();
        global.chrome = originalChrome;
        global.window = originalWindow;
    }
}

var completed = false;
process.on('beforeExit', function() { if(!completed) { console.error('HTTPS auth test did not complete.'); process.exitCode = 1; } });
main().then(function() { completed = true; }).catch(function(error) { completed = true;
    console.error(error.stack || error);
    process.exitCode = 1;
});
