'use strict';

var assert = require('assert');

var originalChrome = global.chrome;
var originalWindow = global.window;
var localData = {};
var changeListeners = [];
var syncCalls = 0;
var nextGetError = null;
var nextSetError = null;
var runtime = { lastError: null };

var local = {
    get: function(keys, callback) {
        var result = {};
        if(nextGetError) {
            runtime.lastError = { message: nextGetError };
            nextGetError = null;
            callback(result);
            runtime.lastError = null;
            return;
        }
        var names = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys || {});
        names.forEach(function(key) {
            if(Object.prototype.hasOwnProperty.call(localData, key)) result[key] = localData[key];
            else if(keys && !Array.isArray(keys) && typeof keys === 'object' && Object.prototype.hasOwnProperty.call(keys, key)) result[key] = keys[key];
        });
        callback(result);
    },
    set: function(values, callback) {
        if(nextSetError) {
            runtime.lastError = { message: nextSetError };
            nextSetError = null;
            callback();
            runtime.lastError = null;
            return;
        }
        var changes = {};
        Object.keys(values).forEach(function(key) {
            changes[key] = {
                oldValue: localData[key],
                newValue: values[key]
            };
            localData[key] = values[key];
        });
        changeListeners.slice().forEach(function(listener) { listener(changes, 'local'); });
        callback();
    }
};

global.window = {};
global.chrome = {
    runtime: runtime,
    storage: {
        local: local,
        sync: {
            get: function() { syncCalls++; },
            set: function() { syncCalls++; }
        },
        onChanged: {
            addListener: function(callback) { changeListeners.push(callback); }
        }
    }
};

var storageModule = require.resolve('../js/storage');
var credentialModule = require.resolve('../js/credential_storage');
delete require.cache[storageModule];
delete require.cache[credentialModule];

function rejects(promise, message) {
    return promise.then(function() {
        throw new Error('Expected rejection: ' + message);
    }, function(error) {
        assert(error instanceof Error);
        if(message) assert(error.message.indexOf(message) !== -1, error.message);
    });
}

async function main() {
    try {
        var Storage = require('../js/storage');
        assert.strictEqual(await Storage.getAsync('missing', 'fallback'), 'fallback');
        assert.strictEqual(syncCalls, 0, 'credential storage must not probe or use browser sync storage');

        var errors = 0;
        var successes = 0;
        var unregisterError = Storage.onError(function() { errors++; });
        var unregisterSuccess = Storage.onSuccess(function() { successes++; });
        var firstChanges = 0;
        var secondChanges = 0;
        var unregisterFirst = Storage.register('sample', function(value) {
            assert.strictEqual(value, 'stored');
            firstChanges++;
        });
        var unregisterSecond = Storage.register('sample', function(value) {
            assert.strictEqual(value, 'stored');
            secondChanges++;
        });

        await Storage.setAsync('sample', 'stored');
        assert.strictEqual(changeListeners.length, 1, 'only one chrome.storage.onChanged listener should be installed');
        assert.strictEqual(firstChanges, 1, 'each subscriber should receive one update');
        assert.strictEqual(secondChanges, 1, 'each subscriber should receive one update');
        assert.strictEqual(successes, 1);
        assert.strictEqual(await Storage.getAsync('sample'), 'stored');

        unregisterFirst();
        await Storage.setAsync('sample', 'stored');
        assert.strictEqual(firstChanges, 1, 'unsubscribed callbacks must not run');
        assert.strictEqual(secondChanges, 2);

        nextGetError = 'mock read failure';
        await rejects(Storage.getAsync('sample'), 'mock read failure');
        nextSetError = 'mock quota failure';
        await rejects(Storage.set('sample', 'not-saved'), 'mock quota failure');
        assert.strictEqual(errors, 2, 'read and write errors should be observable');
        assert.strictEqual(await Storage.getAsync('sample'), 'stored');

        await Storage.get('absent', function(value) {
            assert.strictEqual(value, 'default callback value');
        }, 'default callback value');

        var CredentialStorage = require('../js/credential_storage');
        await new Promise(function(resolve) { setImmediate(resolve); });
        var credential = {
            url: '^https://secure.example/',
            username: 'review-user',
            password: 'test-only-password',
            priority: '1'
        };
        await CredentialStorage.addCredential(credential);
        assert.strictEqual(CredentialStorage.getCredentials({ url: 'https://secure.example/' }).length, 1);
        var beforeFailedWrite = CredentialStorage.asJSON();

        nextSetError = 'mock credential quota failure';
        await rejects(CredentialStorage.addCredential({
            url: '^https://another.example/', username: 'u', password: 'p', priority: '1'
        }), 'mock credential quota failure');
        assert.strictEqual(CredentialStorage.asJSON(), beforeFailedWrite, 'failed writes must not change in-memory credentials');

        nextSetError = 'mock remove quota failure';
        await rejects(CredentialStorage.removeCredential(credential.url), 'mock remove quota failure');
        assert.strictEqual(CredentialStorage.asJSON(), beforeFailedWrite, 'failed deletes must retain the in-memory credential');

        await CredentialStorage.addCredentials([
            { url: '^https://one.example/', username: 'one', password: '1', priority: '1' },
            { url: '^https://two.example/', username: 'two', password: '2', priority: '2' }
        ]);
        assert.strictEqual(CredentialStorage.getCredentials({ url: 'https://one.example/' }).length, 1);
        assert.strictEqual(CredentialStorage.getCredentials({ url: 'https://two.example/' }).length, 1);

        await CredentialStorage.removeCredential(credential.url);
        assert.strictEqual(CredentialStorage.getCredentials({ url: 'https://secure.example/' }).length, 0);
        await CredentialStorage.clearAll();
        assert.strictEqual(CredentialStorage.asJSON(), '{}');
        assert.strictEqual(syncCalls, 0);

        unregisterSecond();
        unregisterError();
        unregisterSuccess();
        console.log('Storage tests passed.');
    } finally {
        delete require.cache[credentialModule];
        delete require.cache[storageModule];
        global.chrome = originalChrome;
        global.window = originalWindow;
    }
}

main().catch(function(error) {
    console.error(error.stack || error);
    process.exitCode = 1;
});
