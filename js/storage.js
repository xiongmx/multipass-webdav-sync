/*global Promise*/
'use strict';

var Vault = require('./vault');
module.exports = (function() {
    var storage = chrome.storage;
    if(!storage || !storage.local) throw new Error('Local extension storage is unavailable.');
    var listenerCallbacks = Object.create(null);
    var errorCallbacks = [];
    var successCallbacks = [];
    var queues = Object.create(null);
    var changeListenerInstalled = false;
    var lastStorageError = null;
    var CONFIG_KEY = Vault.constants.configKey;
    var LEGACY_VALUES_KEY = Vault.constants.encryptedValuesKey;

    function reportError(error) {
        lastStorageError = error;
        errorCallbacks.slice().forEach(function(callback) { try { callback(error); } catch (e) { /* observer failure is isolated */ } });
    }
    function reportSuccess() {
        lastStorageError = null;
        successCallbacks.slice().forEach(function(callback) { try { callback(); } catch (e) { /* observer failure is isolated */ } });
    }
    function getAsync(key, fallback) {
        return Vault.getAsync(key, fallback).catch(function(error) { reportError(error); throw error; });
    }
    function get(key, callback, fallback) {
        var promise = getAsync(key, fallback);
        if(typeof callback !== 'function') return promise;
        return promise.then(function(value) { callback(value); return value; });
    }
    function setAsync(key, value) {
        return Vault.setAsync(key, value).then(function(result) { reportSuccess(); return result; })
            .catch(function(error) { reportError(error); throw error; });
    }
    function updateAsync(key, fallback, updater) {
        return Vault.updateAsync(key, fallback, updater).then(function(result) { reportSuccess(); return result; })
            .catch(function(error) { reportError(error); throw error; });
    }
    function set(key, value) { return setAsync(key, value); }
    function deliver(key, value) {
        var callbacks = listenerCallbacks[key];
        if(!callbacks) return;
        callbacks.slice().forEach(function(callback) { try { callback(value); } catch (e) { reportError(e); } });
    }
    function queueDeliver(key, work) {
        queues[key] = (queues[key] || Promise.resolve()).then(work, work).catch(function(error) { reportError(error); });
    }
    function dispatchChanges(changes, namespace) {
        if(namespace !== 'local' || !changes) return;
        Object.keys(changes).forEach(function(key) {
            if(key === CONFIG_KEY || key === LEGACY_VALUES_KEY || key === Vault.constants.revocationKey) return;
            queueDeliver(key, function() {
                var envelope = changes[key].newValue;
                if(envelope === undefined) { deliver(key, undefined); return Promise.resolve(); }
                return Vault.decrypt(envelope, 'local:' + key).then(function(value) { deliver(key, value); });
            });
        });
    }
    function reload(key) {
        return Vault.getAsync(key).then(function(value) { deliver(key, value); }, function(error) {
            if(error && error.message === 'Vault is locked.') return;
            reportError(error);
        });
    }
    function installListener() {
        if(!changeListenerInstalled && storage.onChanged && typeof storage.onChanged.addListener === 'function') {
            storage.onChanged.addListener(dispatchChanges);
            changeListenerInstalled = true;
        }
    }
    function register(key, callback) {
        var list;
        if(typeof callback !== 'function') throw new TypeError('A storage change callback is required.');
        list = listenerCallbacks[key] || (listenerCallbacks[key] = []);
        list.push(callback);
        installListener();
        return function() {
            var current = listenerCallbacks[key], index;
            if(!current) return;
            index = current.indexOf(callback);
            if(index !== -1) current.splice(index, 1);
            if(!current.length) delete listenerCallbacks[key];
        };
    }
    function onError(callback) {
        if(typeof callback !== 'function') throw new TypeError('A storage error callback is required.');
        errorCallbacks.push(callback);
        if(lastStorageError) callback(lastStorageError);
        return function() { var i = errorCallbacks.indexOf(callback); if(i !== -1) errorCallbacks.splice(i, 1); };
    }
    function onSuccess(callback) {
        if(typeof callback !== 'function') throw new TypeError('A storage success callback is required.');
        successCallbacks.push(callback);
        return function() { var i = successCallbacks.indexOf(callback); if(i !== -1) successCallbacks.splice(i, 1); };
    }
    Vault.onLock(function() {
        Object.keys(listenerCallbacks).forEach(function(key) {
            queueDeliver(key, function() { deliver(key, undefined); return Promise.resolve(); });
        });
    });
    Vault.onUnlock(function() {
        Object.keys(listenerCallbacks).forEach(function(key) { queueDeliver(key, function() { return reload(key); }); });
    });
    installListener();
    return { get: get, getAsync: getAsync, set: set, setAsync: setAsync,
        updateAsync: updateAsync, removeAsync: Vault.removeAsync, register: register, onError: onError, onSuccess: onSuccess };
}());
