'use strict';

var assert = require('assert');
var webcrypto = require('crypto').webcrypto;
require('./helpers/web_locks').installGlobalWebLocks();
if(!global.crypto) Object.defineProperty(global, 'crypto', { value: webcrypto, configurable: true });
var localData = Object.create(null), sessionData = Object.create(null), listeners = [];
var runtime = { lastError: null }, failLocalWrite = false, failSessionRemove = false, failSessionSet = false, failUnlockedMarker = false;
var delayedSessionGet = null, holdSessionGet = false;
function copy(value) { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)); }
function emit(changes, area) { listeners.slice().forEach(function(fn) { fn(copy(changes), area); }); }
function store(data, area) {
    return {
        get: function(keys, callback) {
            var names = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(data);
            var result = {};
            names.forEach(function(key) { if(Object.prototype.hasOwnProperty.call(data, key)) result[key] = copy(data[key]); });
            if(area === 'session' && holdSessionGet) { holdSessionGet = false; delayedSessionGet = function() { callback(result); }; }
            else callback(result);
        },
        set: function(values, callback) {
            if(area === 'local' && failUnlockedMarker && values.vaultRevocationState && values.vaultRevocationState.locked === false) {
                runtime.lastError = { message: 'Simulated unlocked-marker write failure.' };
                callback(); runtime.lastError = null; return;
            }
            if(area === 'local' && failLocalWrite) {
                runtime.lastError = { message: 'Simulated atomic storage failure.' };
                callback(); runtime.lastError = null; return;
            }
            if(area === 'session' && failSessionSet) {
                runtime.lastError = { message: 'Simulated session set failure.' };
                callback(); runtime.lastError = null; return;
            }
            var changes = {};
            Object.keys(values).forEach(function(key) {
                changes[key] = { oldValue: copy(data[key]), newValue: copy(values[key]) };
                data[key] = copy(values[key]);
            });
            emit(changes, area); callback();
        },
        remove: function(keys, callback) {
            if(area === 'session' && failSessionRemove) {
                runtime.lastError = { message: 'Simulated session removal failure.' };
                callback(); runtime.lastError = null; return;
            }
            var changes = {};
            (Array.isArray(keys) ? keys : [keys]).forEach(function(key) {
                changes[key] = { oldValue: copy(data[key]) }; delete data[key];
            });
            emit(changes, area); callback();
        },
        setAccessLevel: function(options) {
            assert.strictEqual(options.accessLevel, 'TRUSTED_CONTEXTS');
            return Promise.resolve();
        }
    };
}
global.chrome = { runtime: runtime, storage: {
    local: store(localData, 'local'), session: store(sessionData, 'session'),
    onChanged: { addListener: function(callback) { listeners.push(callback); } }
} };
var vaultPath = require.resolve(process.env.VAULT_SOURCE_DIR ? require('path').join(process.env.VAULT_SOURCE_DIR, 'js/vault.js') : '../js/vault');
function context() { delete require.cache[vaultPath]; return require(vaultPath); }
async function publicationFailure() {
    var phrase = 'dummy publication recovery phrase';
    var expected = { example: { url: '^https://example.test/', username: 'dummy', password: 'dummy-publication-secret' } };
    localData.credentials = copy(expected);
    var A = context(), B = context(), unlockEvents = 0;
    await Promise.all([A.ready(), B.ready()]);
    A.onUnlock(function() { unlockEvents++; }); B.onUnlock(function() { unlockEvents++; });
    failUnlockedMarker = true;
    await assert.rejects(A.create(phrase), /publication|marker|locked/);
    assert.strictEqual(A.isUnlocked(), false, 'failed creation must not unlock creator');
    assert.strictEqual(B.isUnlocked(), false, 'failed creation must never unlock another context');
    assert.strictEqual(unlockEvents, 0, 'no unlock notification may precede final publication commit');
    assert.strictEqual(localData.credentials.format, 'multipass-vault-v1', 'encrypted migration must remain recoverable');
    assert(localData.vaultConfig);
    assert.strictEqual(localData.vaultRevocationState.locked, true);
    assert.strictEqual(sessionData.vaultRootMaterial, undefined, 'failed publication must remove root');
    var Fresh = context(); await Fresh.ready(); assert.strictEqual(Fresh.isUnlocked(), false);
    failUnlockedMarker = false;
    await A.unlock(phrase);
    assert.deepStrictEqual(await A.getAsync('credentials'), expected, 'same passphrase must recover migrated data');
    assert.strictEqual(B.isUnlocked(), true);
    await A.lock();
    delete localData.vaultRevocationState;
    emit({ vaultRevocationState: { newValue: undefined } }, 'local');
    var beforeFailedUnlock = unlockEvents;
    failUnlockedMarker = true;
    await assert.rejects(A.unlock(phrase), /publication|marker|locked/);
    assert.strictEqual(unlockEvents, beforeFailedUnlock, 'missing-marker unlock must not publish root before commit');
    assert.strictEqual(B.isUnlocked(), false);
    assert.strictEqual(sessionData.vaultRootMaterial, undefined);
    failUnlockedMarker = false;
    Object.keys(localData).forEach(function(k) { delete localData[k]; });
    Object.keys(sessionData).forEach(function(k) { delete sessionData[k]; });
    listeners = [];
    console.log('Publication failure tests passed: no early unlock, session rollback, fresh-context locked state and same-passphrase recovery.');
}
async function main() {
    await publicationFailure();
    var phrase = 'dummy vault phrase for regression only';
    var original = {
        credentials: { oldHash: { url: '^https://example.test/', username: 'dummy-user', password: 'dummy-migration-secret', priority: 1 } },
        'temporary-credentials': { password: 'dummy-temporary-secret' },
        multipassWebdavSettings: { password: 'dummy-webdav-secret', endpoint: 'https://example.test/dav' },
        multipassWebdavBackups: [{ credentials: { password: 'dummy-backup-secret' } }]
    };
    Object.assign(localData, copy(original));
    var Vault = context();
    await Vault.ready();
    assert.strictEqual(Vault.isUnlocked(), false);
    await assert.rejects(Vault.getAsync('credentials'), /configured|locked/);
    await assert.rejects(Vault.setAsync('credentials', {}), /configured|locked/);
    await assert.rejects(Vault.create('short'));
    assert.deepStrictEqual(copy(localData), original);
    failLocalWrite = true;
    await assert.rejects(Vault.create(phrase));
    failLocalWrite = false;
    assert.deepStrictEqual(copy(localData), original, 'failed migration must retain every original value');
    var unlocks = 0;
    Vault.onUnlock(function() { unlocks++; });
    await Vault.create(phrase);
    assert.strictEqual(unlocks, 1, 'one unlock event per transition');
    assert.strictEqual(Vault.isUnlocked(), true);
    assert(localData.vaultConfig && !localData.vaultEncryptedValues);
    for(var key of Object.keys(original)) {
        assert.strictEqual(localData[key].format, 'multipass-vault-v1');
        assert.deepStrictEqual(await Vault.getAsync(key), original[key], 'migration must not delete encrypted ' + key);
    }
    var persisted = JSON.stringify(localData);
    ['dummy-migration-secret', 'dummy-temporary-secret', 'dummy-webdav-secret', 'dummy-backup-secret', phrase, sessionData.vaultRootMaterial].forEach(function(secret) {
        assert(!persisted.includes(secret), 'no secret or equivalent root in persistent storage');
    });
    var first = await Vault.encrypt({ value: 'dummy-value' }, 'export');
    var second = await Vault.encrypt({ value: 'dummy-value' }, 'export');
    assert.notStrictEqual(first.salt, second.salt);
    assert.notStrictEqual(first.iv, second.iv);
    assert.deepStrictEqual(await Vault.decrypt(first, 'export'), { value: 'dummy-value' });
    await assert.rejects(Vault.decrypt(first, 'backup'));
    var altered = copy(first); altered.parameters.iterations = 1;
    await assert.rejects(Vault.decrypt(altered, 'export'));
    altered = copy(first); altered.ciphertext = (altered.ciphertext[0] === 'A' ? 'B' : 'A') + altered.ciphertext.slice(1);
    await assert.rejects(Vault.decrypt(altered, 'export'));
    var Other = context(); await Other.ready();
    assert.strictEqual(Other.isUnlocked(), true);
    await Promise.all([Vault.setAsync('one', { value: 1 }), Other.setAsync('two', { value: 2 })]);
    assert.deepStrictEqual(await Other.getAsync('one'), { value: 1 });
    assert.deepStrictEqual(await Vault.getAsync('two'), { value: 2 });
    var lockCount = 0, otherLockCount = 0;
    Vault.onLock(function() { lockCount++; }); Other.onLock(function() { otherLockCount++; });
    var pending = Vault.decrypt(first, 'export');
    var rejectedRace = assert.rejects(pending, /locked/);
    await Vault.lock(); await rejectedRace;
    assert.strictEqual(Vault.isUnlocked(), false);
    assert.strictEqual(Other.isUnlocked(), false);
    assert.strictEqual(lockCount, 1); assert.strictEqual(otherLockCount, 1);
    await assert.rejects(Vault.getAsync('credentials'), /locked/);
    await assert.rejects(Vault.unlock('wrong phrase but long enough'));
    assert.strictEqual(Other.isUnlocked(), false);
    await Vault.unlock(phrase);
    assert.strictEqual(unlocks, 2);
    assert.strictEqual(Other.isUnlocked(), true);
    holdSessionGet = true;
    var Stale = context(); var pendingReady = Stale.ready();
    while(!delayedSessionGet) await new Promise(function(resolve) { setImmediate(resolve); });
    await Vault.lock(); delayedSessionGet(); holdSessionGet = false;
    await pendingReady;
    assert.strictEqual(Stale.isUnlocked(), false, 'stale initial snapshot must not undo a lock broadcast');
    await Vault.unlock(phrase);
    failSessionRemove = true;
    await Vault.lock();
    assert.strictEqual(Other.isUnlocked(), false, 'Other must lock without calling Other.lock when session.remove fails');
    assert.strictEqual(sessionData.vaultRootMaterial, null, 'fallback overwrite must eliminate stored root material');
    var FreshSingle = context(); await FreshSingle.ready();
    assert.strictEqual(FreshSingle.isUnlocked(), false);
    failSessionRemove = false;
    await Vault.unlock(phrase);
    assert.strictEqual(Other.isUnlocked(), true);
    var staleRoot = sessionData.vaultRootMaterial;
    failSessionRemove = true; failSessionSet = true;
    await assert.rejects(Vault.lock(), /Global vault lock|session/);
    assert.strictEqual(Vault.isUnlocked(), false, 'origin immediately zeroizes on failure');
    assert.strictEqual(Other.isUnlocked(), false, 'persistent revocation must stop the other context even if session cleanup fails');
    assert.strictEqual(sessionData.vaultRootMaterial, staleRoot, 'failure fixture must really retain stale session root');
    assert.strictEqual(localData.vaultRevocationState.locked, true);
    await assert.rejects(Other.getAsync('credentials'), /locked/);
    await assert.rejects(Other.encrypt({ dummy: true }, 'export'), /locked/);
    var FreshFailed = context(); await FreshFailed.ready();
    assert.strictEqual(FreshFailed.isUnlocked(), false, 'new context must not revive a retained stale session root');
    await assert.rejects(FreshFailed.getAsync('credentials'), /locked/);
    assert(!JSON.stringify(localData).includes(staleRoot), 'revocation marker must not contain root material');
    failSessionRemove = false; failSessionSet = false;
    await Vault.lock();
    assert.strictEqual(sessionData.vaultRootMaterial, undefined);
    await Vault.unlock(phrase);
    failLocalWrite = true;
    await assert.rejects(Vault.lock(), /could not be confirmed|storage failure/);
    failLocalWrite = false;
    assert.strictEqual(Other.isUnlocked(), false, 'session cleanup still runs when local marker write fails');
    assert.strictEqual(sessionData.vaultRootMaterial, undefined);
    var FreshMarkerFailure = context(); await FreshMarkerFailure.ready();
    assert.strictEqual(FreshMarkerFailure.isUnlocked(), false);
    await Vault.unlock(phrase);
    await Vault.removeAsync('one');
    assert.strictEqual(localData.one, undefined);
    await assert.rejects(Vault.removeAsync('vaultConfig'));
    var session = chrome.storage.session;
    chrome.storage.session = undefined;
    await assert.rejects(context().ready(), /session/);
    chrome.storage.session = session;
    console.log('Vault tests passed: migration/AEAD, dual-context lock, remove failure fallback, remove+set failure revocation, fresh-context stale-root rejection, marker-write failure compensation, and lock races.');
}
var completed = false;
process.on('beforeExit', function() { if(!completed) { console.error('Vault test did not complete.'); process.exitCode = 1; } });
main().then(function() { completed = true; }, function(error) { completed = true; console.error(error.stack || error); process.exitCode = 1; });
