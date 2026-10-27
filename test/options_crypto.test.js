'use strict';

var assert = require('assert');
var path = require('path');

function Element(document, tag) {
    this.ownerDocument = document;
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.listeners = Object.create(null);
    this.textContent = '';
    this.value = '';
    this.files = [];
    this.hidden = false;
    this.className = '';
    this.classList = {
        add: function(name) { if((' ' + this.className + ' ').indexOf(' ' + name + ' ') < 0) this.className = (this.className ? this.className + ' ' : '') + name; }.bind(this),
        remove: function(name) { this.className = this.className.split(/\\s+/).filter(function(item) { return item && item !== name; }).join(' '); }.bind(this),
        toggle: function(name, force) { var has = (' ' + this.className + ' ').indexOf(' ' + name + ' ') >= 0; if(force === undefined ? !has : force) this.classList.add(name); else this.classList.remove(name); }
    };
}
Element.prototype.appendChild = function(child) { child.parentNode = this; this.children.push(child); return child; };
Element.prototype.removeChild = function(child) { var i = this.children.indexOf(child); if(i >= 0) this.children.splice(i, 1); child.parentNode = null; return child; };
Element.prototype.remove = function() { if(this.parentNode) this.parentNode.removeChild(this); };
Element.prototype.replaceChildren = function() { var self = this; this.children = []; Array.prototype.slice.call(arguments).forEach(function(child) { self.appendChild(child); }); };
Element.prototype.addEventListener = function(name, handler) { this.listeners[name] = handler; };
Element.prototype.setAttribute = function(name, value) { this[name] = String(value); };
Element.prototype.removeAttribute = function(name) { delete this[name]; };
Element.prototype.matches = function(selector) { return selector.charAt(0) === '.' ? (' ' + this.className + ' ').indexOf(' ' + selector.slice(1) + ' ') >= 0 : this.tagName.toLowerCase() === selector.toLowerCase(); };
Element.prototype.querySelector = function(selector) { return this.ownerDocument.querySelector(selector, this); };
Element.prototype.querySelectorAll = function(selector) { return this.ownerDocument.querySelectorAll(selector, this); };

function Document() {
    this.body = new Element(this, 'body');
    this.domReady = null;
    this.elements = Object.create(null);
    this.bySelector = Object.create(null);
    this.overlay = new Element(this, 'div');
    this.overlay.className = 'overlay';
    this.version = new Element(this, 'span');
    this.version.className = 'multipass-version';
    this.body.appendChild(this.overlay);
    this.body.appendChild(this.version);
}
Document.prototype.createElement = function(tag) { return new Element(this, tag); };
Document.prototype.addEventListener = function(name, handler) { if(name === 'DOMContentLoaded') this.domReady = handler; };
Document.prototype.getElementById = function(id) { return this.elements[id] || null; };
Document.prototype.getElementsByClassName = function(name) { if(name === 'overlay') return [this.overlay]; if(name === 'multipass-version') return [this.version]; return []; };
Document.prototype.querySelector = function(selector) {
    if(this.bySelector[selector]) return this.bySelector[selector];
    if(selector === 'a.export-credentials') return this.bySelector.export;
    if(selector === 'button.import-submit') return this.bySelector.importSubmit;
    if(selector === 'button.clear-all') return this.bySelector.clear;
    if(selector === 'output.import-list') return this.bySelector.output;
    return null;
};
Document.prototype.querySelectorAll = function() { return []; };

function makeDocument() {
    var d = new Document();
    ['import-file', 'import-json', 'storage-status', 'test-urls', 'test-regex'].forEach(function(id) { d.elements[id] = d.createElement('input'); d.elements[id].id = id; });
    d.bySelector.output = d.createElement('output');
    d.bySelector.importSubmit = d.createElement('button');
    d.bySelector.importSubmit.className = 'import-submit';
    d.bySelector.export = d.createElement('a');
    d.bySelector.export.className = 'export-credentials';
    d.bySelector.clear = d.createElement('button');
    d.bySelector.clear.className = 'clear-all';
    return d;
}

function deferred() {
    var result = {};
    result.promise = new Promise(function(resolve, reject) { result.resolve = resolve; result.reject = reject; });
    return result;
}
function flush() { return new Promise(function(resolve) { setTimeout(resolve, 0); }); }
function installMock(name, value) { require.cache[require.resolve(path.join('..', 'js', name))] = { id: require.resolve(path.join('..', 'js', name)), filename: require.resolve(path.join('..', 'js', name)), loaded: true, exports: value }; }
function textOf(node) { return node.textContent + node.children.map(textOf).join(''); }

async function main() {
    var document = makeDocument();
    var unlocked = true;
    var lockCallback;
    var decryptWait;
    var encrypted = [];
    var saved = [];
    var confirmAnswer = false;
    var revoked = [];
    var links = [];
    var storage = { onError: function() {}, onSuccess: function() {} };
    var vault = {
        isUnlocked: function() { return unlocked; },
        encrypt: function(value, kind) { encrypted.push({ value: value, kind: kind }); return Promise.resolve({ format: 'multipass-vault-v1', kind: kind, payload: value }); },
        decrypt: function(envelope, kind) { assert.strictEqual(envelope.format, 'multipass-vault-v1'); assert.strictEqual(kind, envelope.kind); if(decryptWait) return decryptWait.promise; return Promise.resolve(envelope.payload); },
        onLock: function(callback) { lockCallback = callback; },
        lock: function() { unlocked = false; if(lockCallback) lockCallback(); return Promise.resolve(); }
    };
    var credentialStorage = {
        asJSON: function() { return JSON.stringify({ one: { url: 'https://export.test', username: 'export-user', password: 'export-secret', priority: 1 } }); },
        addCredentials: function(value) { if(value.length) saved.push(value); return Promise.resolve(); }
    };
    var credentials = { init: function() {}, sanitize_credential: function(value) { return { url: value.url, username: value.username, password: value.password, priority: value.priority }; } };
    installMock('credentials', credentials);
    installMock('credential_storage', credentialStorage);
    installMock('vault', vault);
    installMock('vault_ui', { init: function() {} });
    installMock('storage', storage);
    installMock('translator', { translate: function(key) { return key; } });
    installMock('webdav_sync', { init: function() {} });
    installMock('auth_policy', { matchesRule: function() { return false; } });
    global.document = document;
    global.window = { confirm: function() { return confirmAnswer; } };
    global.chrome = { runtime: { getManifest: function() { return { version: 'test' }; } } };
    global.Blob = function(parts, options) { this.parts = parts; this.type = options.type; };
    global.URL = { createObjectURL: function() { return 'blob:test-' + (links.length + 1); }, revokeObjectURL: function(url) { revoked.push(url); } };
    global.FileReader = function() {};
    var originalCreate = document.createElement;
    document.createElement = function(tag) { var el = originalCreate.call(document, tag); if(tag === 'a') { links.push(el); el.click = function() { el.clicked = (el.clicked || 0) + 1; }; } return el; };

    require('../js/option');
    document.domReady();
    assert.strictEqual(typeof document.bySelector.export.listeners.click, 'function');

    await document.bySelector.export.listeners.click({ preventDefault: function() {} });
    await flush();
    assert.strictEqual(encrypted.length, 1);
    assert.strictEqual(encrypted[0].kind, 'export');
    assert.strictEqual(links.length, 1);
    assert.strictEqual(links[0].clicked, 1);

    var importText = document.elements['import-json'];
    var submit = document.bySelector.importSubmit;
    importText.value = JSON.stringify({ format: 'multipass-vault-v1', kind: 'backup', payload: [{ url: 'https://array.test', username: 'array-user', password: 'array-secret', priority: 2 }] });
    importText.listeners.change();
    await flush();
    assert(textOf(document.bySelector.output).indexOf('array.test') >= 0);
    assert.strictEqual(textOf(document.bySelector.output).indexOf('array-secret'), -1);
    submit.listeners.click({ preventDefault: function() {} });
    await flush();
    await flush();
    assert.strictEqual(saved.length, 1);
    assert.strictEqual(saved[0][0].url, 'https://array.test');

    importText.value = JSON.stringify({ format: 'multipass-vault-v1', kind: 'backup', payload: { credentials: [{ url: 'https://object.test', username: 'object-user', password: 'object-secret' }] } });
    importText.listeners.change();
    await flush();
    assert(textOf(document.bySelector.output).indexOf('object.test') >= 0);
    submit.listeners.click({ preventDefault: function() {} });
    await flush();
    await flush();
    var savedBeforeLegacy = saved.length;
    assert(savedBeforeLegacy >= 1);

    await vault.lock();
    unlocked = true;
    confirmAnswer = false;
    importText.value = JSON.stringify([{ url: 'https://legacy-cancel.test', username: 'legacy', password: 'legacy-secret' }]);
    importText.listeners.change();
    await flush();
    assert.strictEqual(textOf(document.bySelector.output).indexOf('legacy-cancel.test'), -1);
    submit.listeners.click({ preventDefault: function() {} });
    await flush();
    await flush();
    assert.strictEqual(saved.length, savedBeforeLegacy);

    confirmAnswer = true;
    importText.value = JSON.stringify([{ url: 'https://legacy-cancel.test', username: 'legacy', password: 'legacy-secret' }]);
    importText.listeners.change();
    await flush();
    assert(textOf(document.bySelector.output).indexOf('legacy-cancel.test') >= 0);
    submit.listeners.click({ preventDefault: function() {} });
    await flush();
    await flush();
    assert(saved.length > savedBeforeLegacy);

    decryptWait = deferred();
    importText.value = JSON.stringify({ format: 'multipass-vault-v1', kind: 'export', payload: [{ url: 'https://pending.test', username: 'pending', password: 'pending-secret' }] });
    importText.listeners.change();
    await vault.lock();
    decryptWait.resolve([{ url: 'https://pending.test', username: 'pending', password: 'pending-secret' }]);
    await flush();
    assert.strictEqual(textOf(document.bySelector.output).indexOf('pending.test'), -1);
    assert.strictEqual(importText.value, '');
    assert.strictEqual(document.elements['import-file'].value, '');

    var before = encrypted.length;
    await document.bySelector.export.listeners.click({ preventDefault: function() {} });
    assert.strictEqual(encrypted.length, before);
    submit.listeners.click({ preventDefault: function() {} });
    await flush();
    assert(saved.length > savedBeforeLegacy);

    unlocked = true;
    importText.value = '{not-json';
    assert.doesNotThrow(function() { importText.listeners.change(); });
    await flush();
    assert.strictEqual(textOf(document.bySelector.output).indexOf('Import rejected'), 0);
    assert(revoked.length >= 0);
    require('fs').writeSync(1, 'Option crypto tests passed.\n');
}

var completed = false;
process.on('beforeExit', function() { if(!completed) { require('fs').writeSync(2, 'Option crypto test did not complete.\n'); process.exitCode = 1; } });
main().then(function() { completed = true; }, function(error) { completed = true; require('fs').writeSync(2, (error.stack || error) + '\n'); process.exitCode = 1; });
