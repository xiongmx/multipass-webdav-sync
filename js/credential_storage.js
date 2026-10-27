/*global Promise*/
'use strict';
var Storage = require('./storage');
var Vault = require('./vault');
var AuthPolicy = require('./auth_policy');
module.exports = function() {
    var credentials = Object.create(null), variable_name = 'credentials', writeQueue = Promise.resolve();
    var pendingLoad = Promise.resolve(), cacheEpoch = 0;
    var MAX_URL_LENGTH = 2048, MAX_USERNAME_LENGTH = 1024, MAX_PASSWORD_LENGTH = 4096, MAX_PRIORITY = 1000000;
    var allowed = { url: true, username: true, password: true, priority: true };
    function own(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
    function key(url) { return 'url:' + url; }
    function locked() { return !Vault.isUnlocked(); }
    function vaultError() { return Promise.reject(new Error('Vault is locked.')); }
    function validateCredential(input, allowLegacyRegex) {
        if(!input || typeof input !== 'object' || Array.isArray(input) || (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)) throw new Error('Credential must be a plain object.');
        Object.keys(input).forEach(function(k) { if(!own(allowed, k)) throw new Error('Unknown credential field.'); });
        ['url', 'username', 'password'].forEach(function(k) { if(typeof input[k] !== 'string') throw new Error(k + ' must be a string.'); });
        if(!input.url.length || input.url.length > MAX_URL_LENGTH) throw new Error('Credential URL is too long or empty.');
        if(!allowLegacyRegex) { try { new RegExp(input.url); } catch(error) { throw new Error('Credential URL must be a valid regular expression.'); } }
        if(input.username.length > MAX_USERNAME_LENGTH || input.password.length > MAX_PASSWORD_LENGTH) throw new Error('Credential field is too long.');
        if(own(input, 'priority')) {
            if(typeof input.priority !== 'string' && typeof input.priority !== 'number') throw new Error('Credential priority must be a string or number.');
            var p = Number(input.priority);
            if(!isFinite(p) || p < 0 || p > MAX_PRIORITY) throw new Error('Credential priority is out of range.');
        }
        return { url: input.url, username: input.username, password: input.password, priority: own(input, 'priority') ? input.priority : 1 };
    }
    function items(value) {
        if(Array.isArray(value)) return value;
        if(!value || typeof value !== 'object') return [];
        return Object.keys(value).map(function(k) { return value[k]; });
    }
    function validateAll(value) { if(!Array.isArray(value)) throw new Error('Credentials must be an array.'); return value.map(function(item) { return validateCredential(item, false); }); }
    function normalize(value) {
        var result = Object.create(null), migrated = Array.isArray(value);
        items(value).forEach(function(item) {
            try { var c = validateCredential(item, true); var k = key(c.url); if(!own(value, k)) migrated = true; result[k] = c; } catch(error) { /* malformed legacy entries remain inactive */ }
        });
        return { value: result, migrated: migrated };
    }
    function enqueue(update) {
        if(locked()) return vaultError();
        var start = cacheEpoch;
        var operation = writeQueue.then(function() {
            if(locked() || start !== cacheEpoch) throw new Error('Vault state changed. Retry the edit.');
            var result;
            return Storage.updateAsync(variable_name, {}, function(current) {
                if(locked() || start !== cacheEpoch) throw new Error('Vault state changed. Retry the edit.');
                var next = normalize(current).value;
                result = update(next);
                return next;
            }).then(function(next) { if(locked() || start !== cacheEpoch) throw new Error('Vault state changed.'); credentials = next; return result; });
        });
        writeQueue = operation.then(function() {}, function() {}); return operation;
    }
    function saveCredential(input, oldUrl) {
        var c; try { c = validateCredential(input); } catch(error) { return Promise.reject(error); }
        if(typeof oldUrl !== 'undefined' && typeof oldUrl !== 'string') return Promise.reject(new Error('Old credential URL must be a string.'));
        return enqueue(function(next) { if(typeof oldUrl === 'string') delete next[key(oldUrl)]; next[key(c.url)] = c; return c; });
    }
    function addCredentials(input) { var checked; try { checked = validateAll(input); } catch(error) { return Promise.reject(error); } return enqueue(function(next) { checked.forEach(function(c) { next[key(c.url)] = c; }); }); }
    function removeCredential(url) { if(typeof url !== 'string') return Promise.reject(new Error('Credential URL must be a string.')); var removed; return enqueue(function(next) { removed = next[key(url)]; delete next[key(url)]; return removed; }); }
    function replaceAll(input) { var checked; try { checked = validateAll(items(input)); } catch(error) { return Promise.reject(error); } return enqueue(function(next) { Object.keys(next).forEach(function(k) { delete next[k]; }); checked.forEach(function(c) { next[key(c.url)] = c; }); }); }
    function clearAll() { return enqueue(function(next) { Object.keys(next).forEach(function(k) { delete next[k]; }); }); }
    function getCredential(url) { if(locked()) return null; var c = typeof url === 'string' ? credentials[key(url)] : null; return c ? Object.assign({}, c) : null; }
    function getCredentials(status) {
        if(locked() || !status || !AuthPolicy.isHttpsUrl(status.url)) return [];
        var found = []; Object.keys(credentials).forEach(function(k) { if(AuthPolicy.matchesRule(credentials[k].url, status.url)) found.push(Object.assign({}, credentials[k])); }); return found.sort(sortCredentials);
    }
    function sortCredentials(a, b) { return Number(a.priority === undefined ? 1 : a.priority) - Number(b.priority === undefined ? 1 : b.priority); }
    function register(callback) { var unregister = Storage.register(variable_name, callback); callback(locked() ? {} : credentials); return unregister; }
    function reload(value) { if(locked()) return; var normalized = normalize(value); credentials = normalized.value; if(normalized.migrated && !locked()) Storage.updateAsync(variable_name, {}, function(current) { return normalize(current).value; }).catch(function() {}); }
    function load() { if(locked()) return Promise.reject(new Error('Vault is locked.')); pendingLoad = Storage.getAsync(variable_name, {}).then(reload); return pendingLoad; }
    function clearCache() { credentials = Object.create(null); }
    Storage.register(variable_name, function(value) { if(value === undefined) clearCache(); else reload(value); });
    if(typeof Vault.onLock === 'function') Vault.onLock(function() { cacheEpoch++; clearCache(); });
    if(typeof Vault.onUnlock === 'function') Vault.onUnlock(function() { load().catch(function() {}); });
    var initialReady = Vault.ready().then(function() { if(Vault.isUnlocked()) return load(); }).catch(function() {});
    function ready() { return initialReady.then(function() { if(locked()) throw new Error('Vault is locked.'); return pendingLoad; }).then(function() { return Vault.verifyUnlocked(); }); }
    return { ready: ready, register: register, getCredentials: getCredentials, getCredential: getCredential, sortCredentials: sortCredentials, removeCredential: removeCredential, clearAll: clearAll, replaceAll: replaceAll, addCredential: saveCredential, addCredentials: addCredentials, saveCredential: saveCredential, validateCredential: validateCredential, asJSON: function() { return locked() ? '{}' : JSON.stringify(credentials); } };
}();
