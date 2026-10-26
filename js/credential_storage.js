/*global Promise*/
'use strict';

var Storage = require('./storage');

module.exports = function() {
    var credentials = {};
    var variable_name = 'credentials';
    var writeQueue = Promise.resolve();

    function _key(key) {
        var hash = 0;
        var len = key.length;

        if (len === 0) return hash;

        for (var i = 0; i < len; i++) {
            var chr = key.charCodeAt(i);
            hash = ((hash << 5) - hash) + chr;
            hash |= 0;
        }
        return hash;
    }

    function clone(source) {
        var result = {};
        Object.keys(source || {}).forEach(function(key) {
            result[key] = source[key];
        });
        return result;
    }

    function enqueueWrite(update) {
        var operation = writeQueue.then(function() {
            var next = clone(credentials);
            var result = update(next);
            return Storage.setAsync(variable_name, next).then(function() {
                credentials = next;
                return result;
            });
        });
        writeQueue = operation.then(function() {}, function() {});
        return operation;
    }

    function saveCredential(credential, oldUrl) {
        if(!credential || typeof credential.url !== 'string') {
            return Promise.reject(new Error('A credential URL is required.'));
        }
        return enqueueWrite(function(next) {
            if(typeof oldUrl === 'string') delete next[_key(oldUrl)];
            next[_key(credential.url)] = credential;
            return credential;
        });
    }

    function addCredential(credential) {
        return saveCredential(credential);
    }

    function addCredentials(items) {
        var input = Array.isArray(items) ? items : [];
        return enqueueWrite(function(next) {
            input.forEach(function(credential) {
                if(!credential || typeof credential.url !== 'string') {
                    throw new Error('Every imported credential must have a URL.');
                }
                next[_key(credential.url)] = credential;
            });
        });
    }

    function removeCredential(url) {
        var removed;
        return enqueueWrite(function(next) {
            var key = _key(url);
            removed = next[key];
            delete next[key];
            return removed;
        });
    }

    function replaceAll(newCredentials) {
        var items = Array.isArray(newCredentials) ? newCredentials : Object.keys(newCredentials || {}).map(function(key) {
            return newCredentials[key];
        });
        return enqueueWrite(function(next) {
            Object.keys(next).forEach(function(key) { delete next[key]; });
            items.forEach(function(credential) {
                if(credential && typeof credential.url === 'string') {
                    next[_key(credential.url)] = credential;
                }
            });
        });
    }

    function clearAll() {
        return enqueueWrite(function(next) {
            Object.keys(next).forEach(function(key) { delete next[key]; });
        });
    }

    function getCredentials(status) {
        var found = [];
        for (var key in credentials) {
            if (Object.prototype.hasOwnProperty.call(credentials, key)) {
                try {
                    var re = new RegExp(credentials[key].url);
                    if (re.test(status.url)) found.push(credentials[key]);
                } catch(e) {
                    // the regex contained an error
                }
            }
        }

        found.sort(sortCredentials);
        return found;
    }

    function register(callback) {
        var unregister = Storage.register(variable_name, callback);
        callback(credentials);
        return unregister;
    }

    function updateCredentials(result) {
        if(Array.isArray(result)) {
            var migrated = {};
            result.forEach(function(credential) {
                if(credential && typeof credential.url === 'string') {
                    migrated[_key(credential.url)] = credential;
                }
            });
            credentials = migrated;
            Storage.setAsync(variable_name, credentials).catch(function() {});
        } else if(result && typeof result === 'object') {
            credentials = result;
        } else {
            credentials = {};
        }
    }

    function sortCredentials(a, b) {
        if(typeof(a.priority) === 'undefined') a.priority = 1;
        if(typeof(b.priority) === 'undefined') b.priority = 1;
        return a.priority - b.priority;
    }

    // Subscribe before loading so a newer write from another extension context
    // cannot be overwritten by a slower initial read.
    var changeRevision = 0;
    Storage.register(variable_name, function(result) {
        changeRevision++;
        updateCredentials(result);
    });
    var initialRevision = changeRevision;
    Storage.getAsync(variable_name, {}).then(function(result) {
        if(changeRevision === initialRevision) updateCredentials(result);
    }).catch(function() {});

    return {
        'register': register,
        'getCredentials': getCredentials,
        'sortCredentials': sortCredentials,
        'removeCredential': removeCredential,
        'clearAll': clearAll,
        'replaceAll': replaceAll,
        'addCredential': addCredential,
        'addCredentials': addCredentials,
        'saveCredential': saveCredential,
        'asJSON': function() { return JSON.stringify(credentials); }
    };
}();
