/*global Promise*/
'use strict';

var assert = require('assert');

function Element(document, tag) {
    this.ownerDocument = document;
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.firstChild = null;
    this.textContent = '';
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.listeners = Object.create(null);
}
Element.prototype.appendChild = function(child) {
    this.children.push(child);
    this.firstChild = this.children[0] || null;
    return child;
};
Element.prototype.insertBefore = function(child, before) {
    var index = before ? this.children.indexOf(before) : -1;
    if(index < 0) this.children.push(child);
    else this.children.splice(index, 0, child);
    this.firstChild = this.children[0] || null;
    return child;
};
Element.prototype.removeChild = function(child) {
    var index = this.children.indexOf(child);
    if(index >= 0) this.children.splice(index, 1);
    this.firstChild = this.children[0] || null;
    return child;
};
Element.prototype.setAttribute = function(name, value) { this[name] = String(value); };
Element.prototype.addEventListener = function(name, handler) { this.listeners[name] = handler; };
Element.prototype.querySelectorAll = function(selector) {
    var result = [], wanted = selector.split(',').map(function(item) { return item.trim().toUpperCase(); });
    function visit(node) {
        node.children.forEach(function(child) {
            if(wanted.indexOf(child.tagName) >= 0) result.push(child);
            visit(child);
        });
    }
    visit(this);
    return result;
};

function Document() {
    this.body = new Element(this, 'body');
}
Document.prototype.createElement = function(tag) { return new Element(this, tag); };

function fakeVault(failPublication) {
    var configured = false;
    var unlocked = false;
    var persistentRoot = false;
    var lockCallback, failLock = false;
    return {
        ready: function() { return Promise.resolve(); },
        isConfigured: function() { return Promise.resolve(configured); },
        isUnlocked: function() { return unlocked; },
        create: function(passphrase) {
            assert.strictEqual(passphrase, 'abcdefghijkl');
            configured = true;
            if(failPublication) { var error = new Error('mock final marker failure'); error.recoveryLocked = true; return Promise.reject(error); }
            unlocked = true;
            persistentRoot = true;
            return Promise.resolve();
        },
        unlock: function(passphrase) {
            assert.strictEqual(passphrase, 'abcdefghijkl');
            unlocked = true;
            persistentRoot = true;
            return Promise.resolve();
        },
        lock: function() {
            unlocked = false;
            persistentRoot = false;
            if(lockCallback) lockCallback();
            if(failLock) { failLock = false; return Promise.reject(new Error('mock session.remove failure')); }
            return Promise.resolve();
        },
        hasPersistentRoot: function() { return persistentRoot; },
        failNextLock: function() { failLock = true; },
        onLock: function(callback) { lockCallback = callback; return function() { lockCallback = null; }; }
    };
}

function find(root, tag, predicate) {
    if(root.tagName === tag.toUpperCase() && (!predicate || predicate(root))) return root;
    for(var i = 0; i < root.children.length; i++) {
        var found = find(root.children[i], tag, predicate);
        if(found) return found;
    }
    return null;
}

function textOf(root) {
    return root.textContent + root.children.map(textOf).join('');
}

async function main() {
    global.chrome = { storage: { local: {}, session: {} } };
    var document = new Document();
    var existing = document.createElement('main');
    document.body.appendChild(existing);
    var mount = document.createElement('div');
    document.body.appendChild(mount);
    var VaultUI = require('../js/vault_ui');
    var vault = fakeVault();
    VaultUI.init({ document: document, container: mount, vault: vault });
    await new Promise(function(resolve) { setTimeout(resolve, 0); });
    assert.strictEqual(document.body.firstChild, existing, 'Vault UI must mount only into the requested settings container');
    assert.strictEqual(mount.firstChild.id, 'vault-ui');
    var section = mount.firstChild;
    var inputs = section.querySelectorAll('input');
    assert.strictEqual(inputs.length, 2, 'Vault creation has one passphrase field and one risk acknowledgement checkbox');
    assert.strictEqual(inputs[0].autocomplete, 'new-password');
    assert(textOf(section).includes('stays unlocked across browser or app restarts'), 'setup must explain persistent unlock behavior');
    assert(textOf(section).includes('browser profile'), 'setup must disclose the profile-access risk');
    var setupToggle = find(section, 'button', function(button) { return button.textContent === 'Show / Hide'; });
    assert(setupToggle, 'setup page must expose the localized show/hide control');
    await setupToggle.listeners.click();
    assert.strictEqual(inputs[0].type, 'text');
    assert.strictEqual(setupToggle['aria-pressed'], 'true');
    await setupToggle.listeners.click();
    assert.strictEqual(inputs[0].type, 'password');
    assert.strictEqual(setupToggle['aria-pressed'], 'false');
    var form = find(section, 'form');
    inputs[0].value = 'abcdefghijkl';
    inputs[1].checked = true;
    await form.listeners.submit({ preventDefault: function() {} });
    assert.strictEqual(inputs[0].value, '');
    await Promise.resolve();
    assert(textOf(section).indexOf('Vault unlocked') >= 0);
    assert.strictEqual(vault.hasPersistentRoot(), true, 'creating the Vault automatically persists the root');

    var lock = find(section, 'button', function(button) { return button.textContent === 'Lock Vault'; });
    await lock.listeners.click();
    await Promise.resolve();
    assert(textOf(section).indexOf('locked on this page') >= 0);
    assert.strictEqual(vault.hasPersistentRoot(), false, 'manual lock clears persistent root material');
    var unlockInput = find(section, 'input');
    assert.strictEqual(unlockInput.autocomplete, 'current-password');
    var unlockToggle = find(section, 'button', function(button) { return button.textContent === 'Show / Hide'; });
    await unlockToggle.listeners.click();
    assert.strictEqual(unlockInput.type, 'text');
    await unlockToggle.listeners.click();
    assert.strictEqual(unlockInput.type, 'password');
    unlockInput.value = 'abcdefghijkl';
    var unlockForm = find(section, 'form');
    await unlockForm.listeners.submit({ preventDefault: function() {} });
    assert.strictEqual(unlockInput.value, '');
    await Promise.resolve();
    assert(textOf(section).indexOf('Vault unlocked') >= 0);
    assert.strictEqual(vault.hasPersistentRoot(), true, 'unlocking automatically resumes persistent unlocked behavior');
    vault.failNextLock();
    await find(section, 'button', function(button) { return button.textContent === 'Lock Vault'; }).listeners.click();
    assert.strictEqual(find(section, 'h2').textContent, 'Global lock is incomplete');
    assert(textOf(section).includes('mock session.remove failure'), 'failure must be in the current DOM, not a removed status node');
    var alert = section.children.filter(function(child) { return child.role === 'alert'; })[0];
    assert(alert && alert.hidden === false, 'persistent live error region must remain visible');
    assert(!textOf(section).includes('Vault locked on this page'), 'failed operation must not render a lock-success heading');
    assert.strictEqual(vault.isUnlocked(), false, 'failure must not restore local secrets');
    await find(section, 'button', function(button) { return button.textContent === 'Retry global lock'; }).listeners.click();
    assert.strictEqual(find(section, 'h2').textContent, 'Vault locked on this page');
    assert(alert.hidden, 'only a successful retry can clear the failure alert');
    VaultUI._unsubscribe();
    delete require.cache[require.resolve('../js/vault_ui')];
    var recoveryUI = require('../js/vault_ui'), recoveryDoc = new Document();
    recoveryUI.init({ document: recoveryDoc, vault: fakeVault(true) });
    await new Promise(function(resolve) { setTimeout(resolve, 0); });
    var recoverySection = recoveryDoc.body.firstChild;
    var recoveryInputs = recoverySection.querySelectorAll('input');
    assert.strictEqual(recoveryInputs.length, 2, 'recovery setup has one passphrase and one risk acknowledgement checkbox');
    recoveryInputs[0].value = 'abcdefghijkl'; recoveryInputs[1].checked = true;
    await find(recoverySection, 'form').listeners.submit({ preventDefault: function() {} });
    assert.strictEqual(find(recoverySection, 'h2').textContent, 'Vault locked on this page');
    assert(textOf(recoverySection).includes('migration data were preserved'));
    assert.strictEqual(find(recoverySection, 'input').autocomplete, 'current-password');
    assert.strictEqual(recoveryInputs[0].value, '');
    assert(recoverySection.children.some(function(child) { return child.role === 'alert' && !child.hidden; }));
    recoveryUI._unsubscribe();
    delete require.cache[require.resolve('../js/vault_ui')];
    var startupUI = require('../js/vault_ui'), startupDoc = new Document(), startupVault = fakeVault();
    startupVault.ready = function() {
        var error = new Error('mock retained persistent-root cleanup failure');
        error.recoveryLocked = false;
        return Promise.reject(error);
    };
    startupUI.init({ document: startupDoc, vault: startupVault });
    await new Promise(function(resolve) { setTimeout(resolve, 0); });
    var startupSection = startupDoc.body.firstChild;
    assert.strictEqual(find(startupSection, 'h2').textContent, 'Global lock is incomplete');
    assert(!textOf(startupSection).includes('Vault locked on this page'), 'startup cleanup failure must not claim successful cleanup');
    await find(startupSection, 'button', function(button) { return button.textContent === 'Retry global lock'; }).listeners.click();
    assert.strictEqual(find(startupSection, 'h2').textContent, 'Vault locked on this page');
    require('fs').writeSync(1, 'Vault UI tests passed: single-entry setup, show/hide controls, settings-only mount, global lock recovery and fail-closed state.\n');
}

var completed = false;
process.on('beforeExit', function() { if(!completed) { console.error('Vault UI test did not complete.'); process.exitCode = 1; } });
main().then(function() { completed = true; }, function(error) { completed = true; require('fs').writeSync(2, (error.stack || error) + '\n'); process.exitCode = 1; });
