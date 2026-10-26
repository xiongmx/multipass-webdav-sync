/*global Promise*/
'use strict';

module.exports = function() {
    var storage = chrome.storage;
    if(!storage || !storage.local) {
        throw new Error('Local extension storage is unavailable.');
    }

    // Credential data deliberately stays in this browser profile. Cross-device
    // transfer is available only through the user-initiated encrypted WebDAV flow.
    var dataStore = storage.local;
    var listenerCallbacks = Object.create(null);
    var errorCallbacks = [];
    var successCallbacks = [];
    var changeListenerInstalled = false;
    var lastStorageError = null;

    function hasOwn(object, key) {
        return Object.prototype.hasOwnProperty.call(object, key);
    }

    function reportError(error) {
        lastStorageError = error;
        errorCallbacks.slice().forEach(function(callback) {
            try {
                callback(error);
            } catch(e) {
                // Error reporting must not interrupt other storage listeners.
            }
        });
    }

    function lastError() {
        var error = chrome.runtime && chrome.runtime.lastError;
        return error ? new Error(error.message || String(error)) : null;
    }

    function reportSuccess() {
        lastStorageError = null;
        successCallbacks.slice().forEach(function(callback) {
            try {
                callback();
            } catch(e) {
                // Status reporting must not interrupt a completed storage write.
            }
        });
    }

    function getAsync(key, defaultValue) {
        return new Promise(function(resolve, reject) {
            dataStore.get(key, function(result) {
                var error = lastError();
                if(error) {
                    reject(error);
                    return;
                }
                if(result && hasOwn(result, key)) resolve(result[key]);
                else resolve(defaultValue);
            });
        }).catch(function(error) {
            reportError(error);
            throw error;
        });
    }

    function get(key, callback, defaultValue) {
        var operation = getAsync(key, defaultValue);
        if(typeof callback !== 'function') return operation;
        return operation.then(function(value) {
            callback(value);
            return value;
        });
    }

    function setAsync(key, value) {
        var data = {};
        data[key] = value;
        return new Promise(function(resolve, reject) {
            dataStore.set(data, function() {
                var error = lastError();
                if(error) reject(error);
                else {
                    reportSuccess();
                    resolve();
                }
            });
        }).catch(function(error) {
            reportError(error);
            throw error;
        });
    }

    function set(key, value) {
        return setAsync(key, value);
    }

    function dispatchChanges(changes, namespace) {
        if(namespace !== 'local' || !changes) return;
        Object.keys(changes).forEach(function(key) {
            var callbacks = listenerCallbacks[key];
            if(!callbacks) return;
            callbacks.slice().forEach(function(callback) {
                try {
                    callback(changes[key].newValue);
                } catch(error) {
                    reportError(error);
                }
            });
        });
    }

    function register(key, callback) {
        if(typeof callback !== 'function') throw new TypeError('A storage change callback is required.');
        if(!listenerCallbacks[key]) listenerCallbacks[key] = [];
        listenerCallbacks[key].push(callback);

        if(!changeListenerInstalled && storage.onChanged && typeof storage.onChanged.addListener === 'function') {
            storage.onChanged.addListener(dispatchChanges);
            changeListenerInstalled = true;
        }

        return function() {
            var callbacks = listenerCallbacks[key];
            if(!callbacks) return;
            var index = callbacks.indexOf(callback);
            if(index !== -1) callbacks.splice(index, 1);
            if(callbacks.length === 0) delete listenerCallbacks[key];
        };
    }

    function onError(callback) {
        if(typeof callback !== 'function') throw new TypeError('A storage error callback is required.');
        errorCallbacks.push(callback);
        if(lastStorageError) callback(lastStorageError);
        return function() {
            var index = errorCallbacks.indexOf(callback);
            if(index !== -1) errorCallbacks.splice(index, 1);
        };
    }

    function onSuccess(callback) {
        if(typeof callback !== 'function') throw new TypeError('A storage success callback is required.');
        successCallbacks.push(callback);
        return function() {
            var index = successCallbacks.indexOf(callback);
            if(index !== -1) successCallbacks.splice(index, 1);
        };
    }

    return {
        'get': get,
        'getAsync': getAsync,
        'set': set,
        'setAsync': setAsync,
        'register': register,
        'onError': onError,
        'onSuccess': onSuccess
    };
}();
