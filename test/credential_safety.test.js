'use strict';
var assert = require('assert');
var values = Object.create(null), locked = false, lockCallbacks = [], unlockCallbacks = [];
var mockVault = {
    constants: { encryptedValuesKey: 'vaultEncryptedValues', configKey: 'vaultConfig' },
    ready: function() { return Promise.resolve(); },
    verifyUnlocked: function() { return locked ? Promise.reject(new Error('Vault is locked.')) : Promise.resolve(); }, isUnlocked: function() { return !locked; },
    onLock: function(cb) { lockCallbacks.push(cb); return function() {}; }, onUnlock: function(cb) { unlockCallbacks.push(cb); return function() {}; },
    getAsync: function(key, fallback) { if(locked) return Promise.reject(new Error('Vault is locked.')); return Promise.resolve(Object.prototype.hasOwnProperty.call(values, key) ? values[key] : fallback); },
    setAsync: function(key, value) { if(locked) return Promise.reject(new Error('Vault is locked.')); values[key] = value; return Promise.resolve(); },
    updateAsync: function(key, fallback, updater) { return mockVault.getAsync(key, fallback).then(updater).then(function(next) { return mockVault.setAsync(key, next).then(function() { return next; }); }); },
    lock: function() { locked = true; lockCallbacks.slice().forEach(function(cb) { cb(); }); },
    unlock: function() { locked = false; unlockCallbacks.slice().forEach(function(cb) { cb(); }); }
};
var vaultPath = require.resolve('../js/vault');
require.cache[vaultPath] = { id: vaultPath, filename: vaultPath, loaded: true, exports: mockVault };
var localData = {};
var listeners = [];
global.chrome = { runtime: { lastError: null }, storage: { local: {
    get: function(key, callback) { var r = {}; r[key] = localData[key]; callback(r); },
    set: function(update, callback) { Object.keys(update).forEach(function(k) { localData[k] = update[k]; listeners.forEach(function(listener) { listener(Object.keys(update).reduce(function(c, x) { c[x] = { newValue: update[x] }; return c; }, {}), 'local'); }); }); callback(); }
}, onChanged: { addListener: function(listener) { listeners.push(listener); } } } };
async function main() {
    var storagePath = require.resolve('../js/storage'), policyPath = require.resolve('../js/auth_policy'), credentialPath = require.resolve('../js/credential_storage');
    delete require.cache[storagePath]; delete require.cache[policyPath]; delete require.cache[credentialPath];
    var CredentialStorage = require('../js/credential_storage');
    await new Promise(function(resolve) { setImmediate(resolve); });
    var first = { url: '^https://Aa.example/', username: '', password: '', priority: '1' };
    var second = { url: '^https://BB.example/', username: 'u', password: 'p', priority: 2 };
    await CredentialStorage.replaceAll([first, second]);
    assert.strictEqual(CredentialStorage.getCredentials({ url: 'http://Aa.example/' }).length, 0);
    assert.strictEqual(CredentialStorage.getCredentials({ url: 'https://Aa.example/' }).length, 1);
    assert.strictEqual(CredentialStorage.getCredential(first.url).password, '');
    assert.strictEqual(CredentialStorage.getCredential('missing'), null);
    var before = CredentialStorage.asJSON();
    await assert.rejects(CredentialStorage.addCredentials([first, { url: '^https://ok/', username: 'u', password: 'p', extra: true }]));
    assert.strictEqual(CredentialStorage.asJSON(), before, 'invalid batch must not partially write');
    await assert.rejects(CredentialStorage.replaceAll([{ url: '^https://ok/', username: 'u', password: 'p', extra: true }]));
    assert.strictEqual(CredentialStorage.asJSON(), before, 'invalid replace must be atomic');
    await assert.rejects(CredentialStorage.addCredential({ url: '^https://x/', username: {}, password: 'p', priority: 1 }));
    assert.strictEqual(Object.keys(JSON.parse(CredentialStorage.asJSON())).length, 2);
    await assert.rejects(CredentialStorage.addCredential({ url: '[', username: 'invalid', password: 'inactive', priority: 9 }));
    await assert.rejects(CredentialStorage.addCredentials([first, { url: '[', username: 'invalid', password: 'inactive' }]));
    await assert.rejects(CredentialStorage.addCredential(JSON.parse('{"url":"^https://x/","username":"u","password":"p","__proto__":{}}')));
    await assert.rejects(CredentialStorage.addCredential({ url: '^https://x/', username: 'u', password: 'p', constructor: 'not-allowed' }));
    assert.strictEqual(CredentialStorage.asJSON(), before, 'all invalid inputs leave the whole store unchanged');
    assert.deepStrictEqual(CredentialStorage.getCredentials({ url: 'https://valid.example/' }), []);
    var setAsync = mockVault.setAsync;
    mockVault.setAsync = function() { return Promise.reject(new Error('mock storage quota error')); };
    await assert.rejects(CredentialStorage.replaceAll([first]), /quota/);
    assert.strictEqual(CredentialStorage.asJSON(), before, 'failed persistence must not replace in-memory credentials');
    mockVault.setAsync = setAsync;
    mockVault.lock();
    assert.strictEqual(CredentialStorage.getCredential(first.url), null);
    assert.deepStrictEqual(CredentialStorage.getCredentials({ url: 'https://Aa.example/' }), []);
    assert.strictEqual(CredentialStorage.asJSON(), '{}');
    await assert.rejects(CredentialStorage.addCredential(first), /locked/);
    mockVault.unlock();
    await new Promise(function(resolve) { setTimeout(resolve, 20); });
    assert.strictEqual(mockVault.isUnlocked(), true);
    console.log('Credential safety tests passed.');
}
main().catch(function(error) { console.error(error.stack || error); process.exitCode = 1; });
