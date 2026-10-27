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
            return Promise.resolve();
        },
        unlock: function(passphrase) {
            assert.strictEqual(passphrase, 'abcdefghijkl');
            unlocked = true;
            return Promise.resolve();
        },
        lock: function() {
            unlocked = false;
            if(lockCallback) lockCallback();
            if(failLock) { failLock = false; return Promise.reject(new Error('mock session.remove failure')); }
            return Promise.resolve();
        },
        failNextLock: function() { failLock = true; },
        onLock: function(callback) { lockCallback = callback; return function() { lockCallback = null; }; }
    };
}

function find(root, tag) {
    if(root.tagName === tag.toUpperCase()) return root;
    for(var i = 0; i < root.children.length; i++) {
        var found = find(root.children[i], tag);
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
    var VaultUI = require('../js/vault_ui');
    var vault = fakeVault();
    VaultUI.init({ document: document, vault: vault });
    await new Promise(function(resolve) { setTimeout(resolve, 0); });
    assert.strictEqual(document.body.firstChild.id, 'vault-ui');
    var section = document.body.firstChild;
    var inputs = section.querySelectorAll('input');
    assert.strictEqual(inputs.length, 3);
    assert.strictEqual(inputs[0].autocomplete, 'new-password');
    assert.strictEqual(inputs[1].autocomplete, 'new-password');
    var form = find(section, 'form');
    inputs[0].value = 'abcdefghijkl';
    inputs[1].value = 'abcdefghijkl';
    inputs[0].value = 'abcdefghijkl';
    inputs[2].checked = true;
    await form.listeners.submit({ preventDefault: function() {} });
    assert.strictEqual(inputs[0].value, '');
    assert.strictEqual(inputs[1].value, '');
    await Promise.resolve();
    assert(textOf(section).indexOf('已解锁') >= 0);

    var lock = find(section, 'button');
    await lock.listeners.click();
    await Promise.resolve();
    assert(textOf(section).indexOf('已锁定') >= 0);
    var unlockInput = find(section, 'input');
    assert.strictEqual(unlockInput.autocomplete, 'current-password');
    unlockInput.value = 'abcdefghijkl';
    var unlockForm = find(section, 'form');
    await unlockForm.listeners.submit({ preventDefault: function() {} });
    assert.strictEqual(unlockInput.value, '');
    await Promise.resolve();
    assert(textOf(section).indexOf('已解锁') >= 0);
    vault.failNextLock();
    await find(section, 'button').listeners.click();
    assert.strictEqual(find(section, 'h2').textContent, '全局锁定未完成');
    assert(textOf(section).includes('mock session.remove failure'), 'failure must be in the current DOM, not a removed status node');
    var alert = section.children.filter(function(child) { return child.role === 'alert'; })[0];
    assert(alert && alert.hidden === false, 'persistent live error region must remain visible');
    assert(!textOf(section).includes('本页保险库已锁定'), 'failed operation must not render a lock-success heading');
    assert.strictEqual(vault.isUnlocked(), false, 'failure must not restore local secrets');
    await find(section, 'button').listeners.click();
    assert.strictEqual(find(section, 'h2').textContent, '本页保险库已锁定');
    assert(alert.hidden, 'only a successful retry can clear the failure alert');
    VaultUI._unsubscribe();
    delete require.cache[require.resolve('../js/vault_ui')];
    var recoveryUI = require('../js/vault_ui'), recoveryDoc = new Document();
    recoveryUI.init({ document: recoveryDoc, vault: fakeVault(true) });
    await new Promise(function(resolve) { setTimeout(resolve, 0); });
    var recoverySection = recoveryDoc.body.firstChild;
    var recoveryInputs = recoverySection.querySelectorAll('input');
    recoveryInputs[0].value = recoveryInputs[1].value = 'abcdefghijkl'; recoveryInputs[2].checked = true;
    await find(recoverySection, 'form').listeners.submit({ preventDefault: function() {} });
    assert.strictEqual(find(recoverySection, 'h2').textContent, '本页保险库已锁定');
    assert(textOf(recoverySection).includes('迁移数据已保留'));
    assert.strictEqual(find(recoverySection, 'input').autocomplete, 'current-password');
    assert.strictEqual(recoveryInputs[0].value, '');
    assert(recoverySection.children.some(function(child) { return child.role === 'alert' && !child.hidden; }));
    require('fs').writeSync(1, 'Vault UI tests passed: synchronous onLock, rejected global lock, visible error, fail-closed local state and successful retry.\n');
}

var completed = false;
process.on('beforeExit', function() { if(!completed) { console.error('Vault UI test did not complete.'); process.exitCode = 1; } });
main().then(function() { completed = true; }, function(error) { completed = true; require('fs').writeSync(2, (error.stack || error) + '\n'); process.exitCode = 1; });
