'use strict';

var assert = require('assert');
var webcrypto = require('crypto').webcrypto;
require('./helpers/web_locks').installGlobalWebLocks();
if(!global.crypto) Object.defineProperty(global, 'crypto', { value: webcrypto, configurable: true });
var localData = Object.create(null), sessionData = Object.create(null), listeners = [];
var runtime = { lastError: null }, failLocalWrite = false, failSessionRemove = false, failSessionSet = false, failUnlockedMarker = false, failRememberRemove = false, corruptRememberWrite = false;
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
            if(area === 'local' && corruptRememberWrite && Object.prototype.hasOwnProperty.call(values, 'vaultRememberedRootMaterial')) {
                values = copy(values);
                values.vaultRememberedRootMaterial = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
            }
            var changes = {};
            Object.keys(values).forEach(function(key) {
                changes[key] = { oldValue: copy(data[key]), newValue: copy(values[key]) };
                data[key] = copy(values[key]);
            });
            emit(changes, area);
            callback();
        },
        remove: function(keys, callback) {
            if(area === 'session' && failSessionRemove) {
                runtime.lastError = { message: 'Simulated session removal failure.' };
                callback(); runtime.lastError = null; return;
            }
            var names = Array.isArray(keys) ? keys : [keys];
            if(area === 'local' && failRememberRemove && names.indexOf('vaultRememberedRootMaterial') !== -1) {
                runtime.lastError = { message: 'Simulated remembered-root removal failure.' };
                callback(); runtime.lastError = null; return;
            }
            var changes = {};
            names.forEach(function(key) {
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
    assert.strictEqual(localData.vaultRememberedRootMaterial, undefined, 'failed publication must remove persistent root material');
    var Fresh = context(); await Fresh.ready(); assert.strictEqual(Fresh.isUnlocked(), false);
    failUnlockedMarker = false;
    await A.unlock(phrase);
    assert.deepStrictEqual(await A.getAsync('credentials'), expected, 'same passphrase must recover migrated data');
    assert.strictEqual(B.isUnlocked(), true);
    await A.lock();
    var beforeRootFailure = unlockEvents;
    corruptRememberWrite = true;
    await assert.rejects(A.unlock(phrase), /publication|Persistent Vault root/);
    corruptRememberWrite = false;
    assert.strictEqual(unlockEvents, beforeRootFailure, 'failed persistent-root read-back must never publish an unlock');
    assert.strictEqual(localData.vaultRevocationState.locked, true);
    assert.strictEqual(localData.vaultRememberedRootMaterial, undefined, 'failed root verification must clear the persistent root');
    assert.strictEqual(sessionData.vaultRootMaterial, undefined, 'failed root verification must leave no session root');
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
    console.log('Publication failure tests passed: no early unlock, persistent-root read-back rollback, session rollback, fresh-context locked state and same-passphrase recovery.');
}
async function persistentUnlockSemantics() {
    Object.keys(localData).forEach(function(k) { delete localData[k]; });
    Object.keys(sessionData).forEach(function(k) { delete sessionData[k]; });
    listeners = [];
    failRememberRemove = false;
    var phrase = 'persistent-unlock regression phrase';
    var key = 'vaultRememberedRootMaterial';
    var first = context();
    await first.create(phrase);
    assert.strictEqual(typeof localData[key], 'string', 'Vault creation persists root material by default');
    assert.strictEqual(localData[key], sessionData.vaultRootMaterial, 'only the session root is persisted for restart recovery');
    await first.setAsync('rememberTestValue', { secret: 'encrypted-local-fixture' });
    await first.setAsync('webdavTestSettings', { password: 'dummy-webdav-secret' });
    assert.strictEqual(localData.rememberTestValue.format, 'multipass-vault-v1');
    assert(!JSON.stringify(localData.rememberTestValue).includes('encrypted-local-fixture'), 'local values remain encrypted when the Vault is unlocked');
    assert(!JSON.stringify(localData).includes('dummy-webdav-secret'), 'WebDAV passwords are never persisted in plaintext');
    assert(!JSON.stringify(localData).includes(phrase), 'the Vault passphrase is never persisted');
    delete localData[key];
    var upgradedSession = context();
    await upgradedSession.ready();
    assert.strictEqual(upgradedSession.isUnlocked(), true, 'an active legacy session remains unlocked during upgrade');
    assert.strictEqual(localData[key], sessionData.vaultRootMaterial, 'an active legacy session adopts persistent unlock automatically');
    delete sessionData.vaultRootMaterial;
    var unlockedRestart = context();
    await unlockedRestart.ready();
    assert.strictEqual(unlockedRestart.isUnlocked(), true, 'Vault restores unlocked state after browser restart by default');
    assert.deepStrictEqual(await unlockedRestart.getAsync('rememberTestValue'), { secret: 'encrypted-local-fixture' });
    await unlockedRestart.lock();
    assert.strictEqual(localData[key], undefined, 'manual lock clears persistent remembered material');
    delete sessionData.vaultRootMaterial;
    var lockedRestart = context();
    await lockedRestart.ready();
    assert.strictEqual(lockedRestart.isUnlocked(), false, 'a manual lock cannot be undone by browser restart');
    await lockedRestart.unlock(phrase);
    delete sessionData.vaultRootMaterial;
    var secondRestart = context();
    await secondRestart.ready();
    assert.strictEqual(secondRestart.isUnlocked(), true, 'unlock restores persistent unlocked state on the next restart');
    assert.strictEqual(localData[key], sessionData.vaultRootMaterial);
    failRememberRemove = true;
    await assert.rejects(secondRestart.lock(), /Global vault lock could not be completed|remembered/);
    assert.strictEqual(localData.vaultRevocationState.locked, true, 'durable revocation is committed even if remembered-key cleanup fails');
    assert.strictEqual(secondRestart.isUnlocked(), false, 'cleanup failure must still zeroize the current context');
    await assert.rejects(secondRestart.unlock(phrase), /remembered/);
    assert.strictEqual(secondRestart.isUnlocked(), false, 'unlock cannot publish a new session while stale remembered material cannot be revoked');
    failRememberRemove = false;
    var cleanupRestart = context();
    await cleanupRestart.ready();
    assert.strictEqual(cleanupRestart.isUnlocked(), false, 'a retained remembered key cannot bypass a locked revocation marker');
    assert.strictEqual(localData[key], undefined, 'startup cleanup removes stale remembered key material after lock failure');
    await cleanupRestart.unlock(phrase);
    assert.strictEqual(typeof localData[key], 'string', 'recovery unlock restores automatic persistence');
    failLocalWrite = true;
    failRememberRemove = true;
    await assert.rejects(cleanupRestart.lock(), /Global vault lock|remembered/);
    assert.strictEqual(localData.vaultRevocationState, undefined, 'failed marker write must remove the old unlock permit');
    assert.strictEqual(typeof localData[key], 'string', 'double-fault fixture must actually retain the remembered root');
    delete sessionData.vaultRootMaterial;
    var doubleFailureRestart = context();
    await assert.rejects(doubleFailureRestart.ready(), function(error) { return error.recoveryLocked === false; });
    assert.strictEqual(doubleFailureRestart.isUnlocked(), false, 'missing unlock permit must prevent restart restoration despite retained root');
    failLocalWrite = false;
    failRememberRemove = false;
    await doubleFailureRestart.lock();
    await doubleFailureRestart.ready();
    assert.strictEqual(localData[key], undefined, 'a successful retry must remove retained root material');
    await cleanupRestart.unlock(phrase);
    var previousRevocation = copy(localData.vaultRevocationState);
    localData.vaultRevocationState = { locked: true, generation: previousRevocation.generation + 1 };
    emit({ vaultRevocationState: { oldValue: previousRevocation, newValue: copy(localData.vaultRevocationState) } }, 'local');
    failSessionRemove = true;
    failSessionSet = true;
    var independentCleanup = context();
    await assert.rejects(independentCleanup.ready(), function(error) { return error.recoveryLocked === false; });
    assert.strictEqual(independentCleanup.isUnlocked(), false, 'startup cleanup remains locked when session removal and fallback both fail');
    assert.strictEqual(localData[key], undefined, 'remembered-key cleanup still runs after independent session cleanup fails');
    assert.strictEqual(localData.vaultRevocationState.locked, true, 'failed session cleanup cannot weaken durable revocation');
    failSessionRemove = false;
    failSessionSet = false;
    await cleanupRestart.lock();
    assert.strictEqual(sessionData.vaultRootMaterial, undefined, 'a later successful retry clears the stale session root');

    Object.keys(localData).forEach(function(k) { delete localData[k]; });
    Object.keys(sessionData).forEach(function(k) { delete sessionData[k]; });
    listeners = [];
    console.log('Persistent-unlock tests passed: default persistence, encrypted local values, restart recovery, explicit-lock clearing and fail-closed revocation.');
}
async function main() {
    await publicationFailure();
    await persistentUnlockSemantics();
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
    assert.strictEqual(localData[Vault.constants.rememberedKey], sessionData.vaultRootMaterial, 'only root key material is persisted for automatic unlock');
    ['dummy-migration-secret', 'dummy-temporary-secret', 'dummy-webdav-secret', 'dummy-backup-secret', phrase].forEach(function(secret) {
        assert(!persisted.includes(secret), 'no plaintext passphrase or account secret in persistent storage');
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
    var FreshFailed = context(); await assert.rejects(FreshFailed.ready(), function(error) { return error.recoveryLocked === false; });
    assert.strictEqual(FreshFailed.isUnlocked(), false, 'new context must not revive a retained stale session root');
    await assert.rejects(FreshFailed.getAsync('credentials'), /locked|Global vault lock/);
    assert(!JSON.stringify(localData).includes(staleRoot), 'revocation marker must not contain root material');
    failSessionRemove = false; failSessionSet = false;
    await Vault.lock();
    assert.strictEqual(sessionData.vaultRootMaterial, undefined);
    await Vault.unlock(phrase);
    failLocalWrite = true;
    await Vault.lock();
    failLocalWrite = false;
    assert.strictEqual(localData.vaultRevocationState, undefined, 'marker removal is a verified durable fail-closed fallback');
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
