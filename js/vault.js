/*global Promise, Uint8Array*/
'use strict';

module.exports = (function() {
    var local = chrome.storage && chrome.storage.local;
    var session = chrome.storage && chrome.storage.session;
    var changed = chrome.storage && chrome.storage.onChanged;
    var CONFIG_KEY = 'vaultConfig';
    var VALUES_KEY = 'vaultEncryptedValues';
    var SESSION_KEY = 'vaultRootMaterial';
    var REVOCATION_KEY = 'vaultRevocationState';
    var FORMAT = 'multipass-vault-v1';
    var ITERATIONS = 600000;
    var SALT_BYTES = 16;
    var IV_BYTES = 12;
    var MAX_B64 = 16 * 1024 * 1024;
    var MAX_VALUE_BYTES = 8 * 1024 * 1024;
    var LEGACY_KEYS = [
        'credentials', 'temporary-credentials', 'multipassWebdavSettings',
        'multipassWebdavBackups', 'multipassWebdavSyncMeta',
        'multipassWebdavAutoStatus'
    ];
    var rootMaterial = null;
    var epoch = 0;
    var sessionSerial = 0;
    var readyPromise = null;
    var lockCallbacks = [];
    var unlockCallbacks = [];
    var sessionListenerInstalled = false;
    var revocationKnown = false;
    var revoked = false;
    var localLockPending = 0, localLockSerial = 0;

    function own(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
    function fail(message) { return new Error(message); }
    function exclusive(work) {
        if(typeof navigator === 'undefined' || !navigator.locks || typeof navigator.locks.request !== 'function') {
            return Promise.reject(fail('Cross-context Web Locks are unavailable. No data was written.'));
        }
        return navigator.locks.request('multipass-vault:storage', { mode: 'exclusive' }, work);
    }
    function validateLocalKey(key) {
        if(typeof key !== 'string' || !/^[A-Za-z0-9._-]{1,100}$/.test(key) ||
            [CONFIG_KEY, SESSION_KEY, REVOCATION_KEY, '__proto__', 'constructor', 'prototype'].indexOf(key) !== -1) {
            throw fail('Invalid vault storage key.');
        }
    }
    function callbackPromise(fn) {
        return new Promise(function(resolve, reject) {
            try { fn(resolve, reject); } catch (e) { reject(e); }
        });
    }
    function chromeError() {
        var error = chrome.runtime && chrome.runtime.lastError;
        return error ? fail(error.message || 'Storage operation failed.') : null;
    }
    function get(store, keys) {
        return callbackPromise(function(resolve, reject) {
            store.get(keys, function(value) {
                var error = chromeError();
                if(error) reject(error); else resolve(value || {});
            });
        });
    }
    function set(store, value) {
        return callbackPromise(function(resolve, reject) {
            store.set(value, function() {
                var error = chromeError();
                if(error) reject(error); else resolve();
            });
        });
    }
    function remove(store, keys) {
        return callbackPromise(function(resolve, reject) {
            if(typeof store.remove !== 'function') { reject(fail('Storage removal is unavailable.')); return; }
            store.remove(keys, function() {
                var error = chromeError();
                if(error) reject(error); else resolve();
            });
        });
    }
    function bytesToB64(bytes) {
        var text = '', i;
        for(i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i]);
        return btoa(text);
    }
    function b64ToBytes(value, expected) {
        var raw, result, i;
        if(typeof value !== 'string' || !value.length || value.length > MAX_B64 ||
            !/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 === 1) {
            throw fail('Invalid vault encoding.');
        }
        try { raw = atob(value); } catch (e) { throw fail('Invalid vault encoding.'); }
        if(expected !== undefined && raw.length !== expected) throw fail('Invalid vault encoding.');
        result = new Uint8Array(raw.length);
        for(i = 0; i < raw.length; i++) result[i] = raw.charCodeAt(i);
        return result;
    }
    function jsonBytes(value) {
        var text;
        try { text = JSON.stringify(value); } catch (e) { throw fail('Vault value is not serializable.'); }
        if(typeof text !== 'string' || text.length > MAX_VALUE_BYTES) throw fail('Vault value is too large.');
        return new TextEncoder().encode(text);
    }
    function validateKind(kind) {
        if(typeof kind !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(kind)) throw fail('Invalid vault kind.');
    }
    function parameters() {
        return { cipher: 'AES-GCM-256', kdf: 'PBKDF2-SHA256', iterations: ITERATIONS,
            saltBytes: SALT_BYTES, ivBytes: IV_BYTES };
    }
    function aad(kind) { return jsonBytes({ format: FORMAT, kind: kind, parameters: parameters() }); }
    function validateEnvelope(envelope, kind) {
        var p;
        validateKind(kind);
        if(!envelope || typeof envelope !== 'object' || Array.isArray(envelope) ||
            envelope.format !== FORMAT || envelope.kind !== kind) throw fail('Invalid vault envelope.');
        p = envelope.parameters;
        if(!p || p.cipher !== 'AES-GCM-256' || p.kdf !== 'PBKDF2-SHA256' ||
            p.iterations !== ITERATIONS || p.saltBytes !== SALT_BYTES || p.ivBytes !== IV_BYTES) {
            throw fail('Invalid vault envelope.');
        }
        b64ToBytes(envelope.salt, SALT_BYTES);
        b64ToBytes(envelope.iv, IV_BYTES);
        if(b64ToBytes(envelope.ciphertext).length < 16) throw fail('Invalid vault envelope.');
    }
    function derive(material, salt) {
        return crypto.subtle.importKey('raw', material, { name: 'PBKDF2' }, false, ['deriveKey'])
            .then(function(base) { return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: salt,
                iterations: ITERATIONS, hash: 'SHA-256' }, base,
            { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']); });
    }
    function material(passphrase) {
        if(typeof passphrase !== 'string' || passphrase.trim().length < 12 || passphrase.length > 1024) {
            return Promise.reject(fail('Passphrase must contain 12-1024 non-whitespace characters.'));
        }
        return crypto.subtle.digest('SHA-256', new TextEncoder().encode(passphrase));
    }
    function encryptWithMaterial(value, kind, materialBytes) {
        var salt, iv;
        validateKind(kind);
        salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
        iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
        return derive(materialBytes, salt).then(function(key) {
            return crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv, additionalData: aad(kind), tagLength: 128 },
                key, jsonBytes(value));
        }).then(function(ciphertext) { return { format: FORMAT, kind: kind, parameters: parameters(),
            salt: bytesToB64(salt), iv: bytesToB64(iv), ciphertext: bytesToB64(new Uint8Array(ciphertext)) }; });
    }
    function decryptWithMaterial(envelope, kind, materialBytes) {
        var salt, iv, ciphertext;
        validateEnvelope(envelope, kind);
        salt = b64ToBytes(envelope.salt, SALT_BYTES);
        iv = b64ToBytes(envelope.iv, IV_BYTES);
        ciphertext = b64ToBytes(envelope.ciphertext);
        return derive(materialBytes, salt).then(function(key) {
            return crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv, additionalData: aad(kind), tagLength: 128 },
                key, ciphertext);
        }).then(function(plain) {
            var value;
            try { value = JSON.parse(new TextDecoder().decode(plain)); } catch (e) { throw fail('Invalid vault plaintext.'); }
            return value;
        });
    }
    function getConfig() { return get(local, CONFIG_KEY).then(function(v) { return v[CONFIG_KEY]; }); }
    function validateRevocation(value) {
        if(value === undefined) return { locked: false, generation: 0 };
        if(!value || typeof value !== 'object' || Array.isArray(value) ||
            typeof value.locked !== 'boolean' || typeof value.generation !== 'number' ||
            !isFinite(value.generation) || value.generation < 0) throw fail('Invalid vault revocation state.');
        return { locked: value.locked, generation: value.generation };
    }
    function applyRevocation(value) {
        var state = validateRevocation(value), wasRevoked = revoked, hadRoot = !!rootMaterial;
        revocationKnown = true;
        revoked = state.locked;
        if(revoked) {
            epoch++;
            zeroize();
            if(!wasRevoked && hadRoot) notify(lockCallbacks);
        }
        return state;
    }
    function getRevocation() {
        return get(local, REVOCATION_KEY).then(function(value) {
            return applyRevocation(value[REVOCATION_KEY]);
        });
    }
    function setRevocation(locked, generation) {
        var value = {};
        value[REVOCATION_KEY] = { locked: !!locked, generation: generation };
        return set(local, value).then(function() { return getRevocation(); });
    }
    function ensureActive() {
        return getRevocation().then(function(state) {
            if(state.locked || revoked) throw fail('Vault is locked.');
            return state;
        });
    }
    function secureSessionAvailable() {
        return !!(session && typeof session.get === 'function' && typeof session.set === 'function' &&
            typeof session.remove === 'function');
    }
    function ensureSession() {
        if(!secureSessionAvailable()) return Promise.reject(fail('Secure session storage is unavailable.'));
        if(typeof session.setAccessLevel !== 'function') return Promise.resolve();
        return callbackPromise(function(resolve, reject) {
            try {
                var result = session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
                if(result && typeof result.then === 'function') result.then(resolve, reject); else resolve();
            } catch (e) { reject(e); }
        });
    }
    function zeroize() { if(rootMaterial) rootMaterial.fill(0); rootMaterial = null; }
    function notify(list) { list.slice().forEach(function(callback) { try { callback(); } catch (e) { /* observer failure is isolated */ } }); }
    function applySession(value) {
        if(localLockPending) return;
        var next = null, was = !!rootMaterial;
        if(value && value[SESSION_KEY]) next = b64ToBytes(value[SESSION_KEY], 32);
        if(next) {
            if(was && next.every(function(byte, index) { return byte === rootMaterial[index]; })) return;
            epoch++;
            zeroize(); rootMaterial = next;
            if(was) notify(lockCallbacks);
            notify(unlockCallbacks);
        } else if(was) { epoch++; zeroize(); notify(lockCallbacks); }
    }
    function installSessionListener() {
        if(sessionListenerInstalled || !changed || typeof changed.addListener !== 'function') return;
        changed.addListener(function(changes, namespace) {
            if(namespace === 'local' && changes && own(changes, REVOCATION_KEY)) {
                try {
                    var marker = applyRevocation(changes[REVOCATION_KEY].newValue);
                    if(!marker.locked) {
                        var readLockSerial = localLockSerial;
                        get(session, SESSION_KEY).then(function(value) {
                            if(!revoked && readLockSerial === localLockSerial) applySession(value);
                        }).catch(function() { /* remain locked when session cannot be read */ });
                    }
                }
                catch (e) { var hadRoot = !!rootMaterial; revoked = true; revocationKnown = true; epoch++; zeroize(); if(hadRoot) notify(lockCallbacks); }
            } else if(namespace === 'session' && changes && own(changes, SESSION_KEY)) {
                sessionSerial++;
                try {
                    var update = {};
                    update[SESSION_KEY] = changes[SESSION_KEY].newValue;
                    if(!revoked) applySession(update);
                } catch (e) { epoch++; zeroize(); notify(lockCallbacks); }
            }
        });
        sessionListenerInstalled = true;
    }
    function ready() {
        var observedSerial;
        if(!readyPromise) readyPromise = ensureSession().then(function() {
            installSessionListener();
            observedSerial = sessionSerial;
            return getRevocation().then(function(state) {
                if(state.locked) return null;
                return get(session, SESSION_KEY);
            });
        }).then(function(value) { if(value && observedSerial === sessionSerial && !revoked) applySession(value); return undefined; }).catch(function(error) {
            zeroize(); throw error;
        });
        return readyPromise;
    }
    function isUnlocked() { return !!rootMaterial && !revoked && !localLockPending; }
    function isConfigured() { return ready().then(getConfig).then(function(config) { return !!config; }); }
    function requireUnlocked() { return isUnlocked() && revocationKnown ? Promise.resolve() : Promise.reject(fail('Vault is locked.')); }
    function verifyUnlocked() { return ready().then(ensureActive).then(requireUnlocked); }
    function currentEpoch() { return epoch; }
    function checkEpoch(value) { if(value !== epoch || !rootMaterial || revoked) throw fail('Vault is locked.'); }
    function publishSession(sessionValue, generation) {
        return set(session, sessionValue).then(function() {
            return setRevocation(false, generation).then(function() { applySession(sessionValue); });
        }).catch(function(error) {
            var hadRoot = !!rootMaterial, markerError = null, cleanupError = null;
            localLockPending++; localLockSerial++; epoch++;
            zeroize(); revoked = true; revocationKnown = true;
            if(hadRoot) notify(lockCallbacks);
            return setRevocation(true, generation + 1).catch(function(e) { markerError = e; }).then(function() {
                return clearSessionRoot().catch(function(e) { cleanupError = e; });
            }).then(function() {
                localLockPending--;
                var failure = fail('Vault session publication failed. Encrypted data is retained; unlock with the same passphrase. ' + error.message);
                failure.recoveryLocked = !markerError && !cleanupError;
                throw failure;
            });
        });
    }
    function createUnlocked(passphrase) {
        var start;
        return ready().then(function() { start = epoch; return material(passphrase); }).then(function(m) {
            return getConfig().then(function(existing) {
                if(existing) throw fail('Vault is already configured.');
                return get(local, LEGACY_KEYS).then(function(old) {
                    var keys = Object.keys(old), writes = {}, jobs = [];
                    writes[CONFIG_KEY] = { format: FORMAT };
                    writes[REVOCATION_KEY] = { locked: true, generation: 1 };
                    jobs.push(encryptWithMaterial({ marker: 'vault-verifier' }, 'verifier', m).then(function(verifier) {
                        writes[CONFIG_KEY].verifier = verifier;
                    }));
                    keys.forEach(function(key) { jobs.push(encryptWithMaterial(old[key], 'local:' + key, m).then(function(envelope) {
                        writes[key] = envelope;
                    })); });
                    return Promise.all(jobs).then(function() {
                        if(start !== epoch) throw fail('Vault is locked.');
                        return set(local, writes).then(function() {
                            var sessionValue = {}; sessionValue[SESSION_KEY] = bytesToB64(new Uint8Array(m));
                            // Configuration, migration and a locked marker are committed before root publication.
                            return publishSession(sessionValue, 2);
                        });
                    });
                });
            });
        });
    }
    function create(passphrase) { return exclusive(function() { return createUnlocked(passphrase); }); }
    function unlockUnlocked(passphrase) {
        var start;
        return ready().then(function() { start = epoch; return material(passphrase); }).then(function(m) {
            return getConfig().then(function(config) {
                if(!config) throw fail('Vault is not configured.');
                return decryptWithMaterial(config.verifier, 'verifier', m).then(function(value) {
                    if(!value || value.marker !== 'vault-verifier') throw fail('Vault unlock failed.');
                    if(start !== epoch) throw fail('Vault state changed. Unlock again.');
                    var sessionValue = {}; sessionValue[SESSION_KEY] = bytesToB64(new Uint8Array(m));
                    return get(local, REVOCATION_KEY).then(function(stateValue) {
                        var state = validateRevocation(stateValue[REVOCATION_KEY]);
                        return setRevocation(true, state.generation + 1).then(function() {
                            return publishSession(sessionValue, state.generation + 2);
                        });
                    });
                });
            });
        });
    }
    function unlock(passphrase) { return exclusive(function() { return unlockUnlocked(passphrase); }); }
    function clearSessionRoot() {
        return remove(session, SESSION_KEY).then(function() { return get(session, SESSION_KEY); }).then(function(value) {
            if(own(value, SESSION_KEY)) throw fail('Secure session root could not be revoked.');
        }).catch(function(removeError) {
            var empty = {}; empty[SESSION_KEY] = null;
            return set(session, empty).then(function() { return get(session, SESSION_KEY); }).then(function(value) {
                if(own(value, SESSION_KEY) && value[SESSION_KEY] !== null) throw removeError;
            });
        });
    }
    function lock() {
        var hadRoot;
        localLockPending++; localLockSerial++;
        epoch++;
        hadRoot = !!rootMaterial;
        zeroize();
        // Mark this context revoked before publishing the durable marker so its
        // own onChanged delivery cannot emit a second lock transition.
        revoked = true;
        revocationKnown = true;
        if(hadRoot) notify(lockCallbacks);
        return exclusive(function() {
            var markerError = null;
            return get(local, REVOCATION_KEY).then(function(value) {
                var state = validateRevocation(value[REVOCATION_KEY]);
                return setRevocation(true, state.generation + 1);
            }).catch(function(error) { markerError = error; }).then(function() {
                // Try both independent revocation channels, even if the first fails.
                return clearSessionRoot().then(function() {
                    if(markerError) throw fail('Global vault lock could not be confirmed: ' + markerError.message);
                }, function(error) {
                    throw fail('Global vault lock could not be completed: ' + error.message);
                });
            });
        }).then(function(result) { localLockPending--; return result; }, function(error) { localLockPending--; throw error; });
    }
    function onLock(callback) { if(typeof callback !== 'function') throw new TypeError('A lock callback is required.'); lockCallbacks.push(callback); return function() { var i = lockCallbacks.indexOf(callback); if(i !== -1) lockCallbacks.splice(i, 1); }; }
    function onUnlock(callback) { if(typeof callback !== 'function') throw new TypeError('An unlock callback is required.'); unlockCallbacks.push(callback); return function() { var i = unlockCallbacks.indexOf(callback); if(i !== -1) unlockCallbacks.splice(i, 1); }; }
    function encrypt(value, kind) { return ready().then(ensureActive).then(requireUnlocked).then(function() { var e = currentEpoch(), m = rootMaterial; return encryptWithMaterial(value, kind, m).then(function(result) { checkEpoch(e); return result; }); }); }
    function decrypt(envelope, kind) { return ready().then(ensureActive).then(requireUnlocked).then(function() { var e = currentEpoch(), m = rootMaterial; return decryptWithMaterial(envelope, kind, m).then(function(result) { checkEpoch(e); return result; }); }); }
    function getAsync(key, fallback) {
        return ready().then(ensureActive).then(function() { return getConfig(); }).then(function(config) {
            if(!config) return Promise.reject(fail('Vault is not configured.'));
            return requireUnlocked().then(function() { var e = currentEpoch(), m = rootMaterial;
                return ensureActive().then(function() { return get(local, key); }).then(function(values) {
                    if(own(values, key)) return decryptWithMaterial(values[key], 'local:' + key, m);
                    return get(local, VALUES_KEY).then(function(legacy) {
                        if(!legacy[VALUES_KEY] || !own(legacy[VALUES_KEY], key)) return fallback;
                        return decryptWithMaterial(legacy[VALUES_KEY][key], 'local:' + key, m);
                    });
                }).then(function(value) { checkEpoch(e); return value; });
            });
        });
    }
    function writeUnlocked(key, value) {
        return ready().then(ensureActive).then(getConfig).then(function(config) {
            if(!config) return Promise.reject(fail('Vault is not configured.'));
            return requireUnlocked().then(function() { var e = currentEpoch(), m = rootMaterial;
                return ensureActive().then(function() { return encryptWithMaterial(value, 'local:' + key, m); }).then(function(envelope) {
                    checkEpoch(e); var item = {}; item[key] = envelope; return set(local, item).then(function() { checkEpoch(e); });
                });
            });
        });
    }
    function transaction(work) {
        return ready().then(ensureActive).then(requireUnlocked).then(function() {
            var start = currentEpoch();
            return exclusive(function() {
                checkEpoch(start);
                return work().then(function(result) { checkEpoch(start); return result; });
            });
        });
    }
    function setAsync(key, value) {
        return Promise.resolve().then(function() { validateLocalKey(key); return transaction(function() { return writeUnlocked(key, value); }); });
    }
    function updateAsync(key, fallback, updater) {
        return Promise.resolve().then(function() {
            validateLocalKey(key);
            if(typeof updater !== 'function') throw fail('A vault updater is required.');
            return transaction(function() {
                return getAsync(key, fallback).then(updater).then(function(value) {
                    return writeUnlocked(key, value).then(function() { return value; });
                });
            });
        });
    }
    function removeAsync(keys) {
        keys = Array.isArray(keys) ? keys.slice() : [keys];
        return Promise.resolve().then(function() {
            keys.forEach(validateLocalKey);
            return ready().then(ensureActive).then(function() { return exclusive(function() {
                return get(local, VALUES_KEY).then(function(values) {
                    var legacy = values[VALUES_KEY], changed = false;
                    if(legacy && keys.indexOf(VALUES_KEY) === -1) {
                        keys.forEach(function(key) { if(own(legacy, key)) { delete legacy[key]; changed = true; } });
                    }
                    if(!changed) return;
                    var update = {}; update[VALUES_KEY] = legacy; return set(local, update);
                }).then(function() { return remove(local, keys); });
            }); });
        });
    }
    installSessionListener();
    return { ready: ready, isUnlocked: isUnlocked, isConfigured: isConfigured, create: create,
        unlock: unlock, lock: lock, onLock: onLock, onUnlock: onUnlock, verifyUnlocked: verifyUnlocked, getAsync: getAsync,
        setAsync: setAsync, updateAsync: updateAsync, removeAsync: removeAsync, encrypt: encrypt, decrypt: decrypt,
        constants: { configKey: CONFIG_KEY, encryptedValuesKey: VALUES_KEY, sessionKey: SESSION_KEY,
            revocationKey: REVOCATION_KEY,
            iterations: ITERATIONS, saltBytes: SALT_BYTES, ivBytes: IV_BYTES } };
}());
