/*global Promise*/
'use strict';

var Vault = require('./vault');
var Translator = require('./translator');

var MIN_PASSPHRASE_LENGTH = 12;
var SECTION_ID = 'vault-ui';

function make(document, tag, text) {
    var element = document.createElement(tag);
    if(text !== undefined) element.textContent = Translator.translateText(text);
    return element;
}

function append(parent, children) {
    children.forEach(function(child) { parent.appendChild(child); });
    return parent;
}

function setText(element, text) {
    element.textContent = Translator.translateText(text);
}

function clearInput(input) {
    if(input) input.value = '';
}

function passwordControl(document, input) {
    var control = make(document, 'div');
    control.className = 'vault-passphrase-control';
    var toggle = make(document, 'button');
    toggle.type = 'button';
    toggle.textContent = Translator.translate('show_hide_password');
    toggle.setAttribute('aria-pressed', 'false');
    toggle.setAttribute('aria-label', toggle.textContent);
    toggle.addEventListener('click', function() {
        var visible = input.type === 'password';
        input.type = visible ? 'text' : 'password';
        toggle.setAttribute('aria-pressed', visible ? 'true' : 'false');
    });
    control.appendChild(input);
    control.appendChild(toggle);
    return control;
}

function securityNotice(document) {
    var notice = make(document, 'p');
    notice.textContent = Translator.translate('vault_persistence_disclosure');
    notice.className = 'vault-persistence-disclosure';
    return notice;
}

function VaultUI() {
    var activeSection = null;
    var activeVault = null;
    var lockUnsubscribe = null;
    var unlockUnsubscribe = null;
    var initialized = false;
    var lockPending = false;
    var lockFailure = null;
    var lockNotice = null;

    function init(options) {
        options = options || {};
        var document = options.document || (typeof window !== 'undefined' ? window.document : null);
        var vault = options.vault || Vault;
        var container = options.container || (document && document.body);
        if(!document || !document.body) throw new Error('VaultUI requires document.body.');
        if(initialized) return activeSection;

        activeVault = vault;
        activeSection = make(document, 'section');
        activeSection.id = SECTION_ID;
        activeSection.setAttribute('aria-live', 'polite');
        lockNotice = make(document, 'p');
        lockNotice.setAttribute('role', 'alert');
        lockNotice.className = 'vault-lock-error';
        lockNotice.hidden = true;
        container.insertBefore(activeSection, container.firstChild || null);
        initialized = true;

        if(typeof vault.onLock === 'function') lockUnsubscribe = vault.onLock(function() {
            if(lockPending) renderLockPending();
            else if(lockFailure) renderLockFailure(lockFailure);
            else renderLocked();
        });
        if(typeof vault.onUnlock === 'function') unlockUnsubscribe = vault.onUnlock(function() { if(!lockPending && !lockFailure) renderUnlocked(); });
        renderLoading();
        Promise.resolve().then(function() { return vault.ready(); }).then(function() {
            return vault.isConfigured();
        }).then(function(configured) {
            if(configured) {
                if(vault.isUnlocked()) renderUnlocked();
                else renderLocked();
            } else {
                renderSetup();
            }
        }).catch(function(error) {
            if(error && error.recoveryLocked === false) renderLockFailure(error);
            else renderError(error);
        });
        return activeSection;
    }

    function resetSection() {
        while(activeSection.firstChild) activeSection.removeChild(activeSection.firstChild);
        if(lockNotice) activeSection.appendChild(lockNotice);
    }

    function renderLoading() {
        resetSection();
        append(activeSection, [make(activeSection.ownerDocument, 'h2', 'Vault'), make(activeSection.ownerDocument, 'p', 'Checking Vault status…')]);
    }

    function renderError(error) {
        resetSection();
        append(activeSection, [make(activeSection.ownerDocument, 'h2', 'Vault'), make(activeSection.ownerDocument, 'p', 'Could not read Vault status: ' + ((error && error.message) || 'Unknown error'))]);
    }

    function renderSetup() {
        var document = activeSection.ownerDocument;
        resetSection();
        append(activeSection, [make(document, 'h2', 'Set up encrypted Vault'), make(document, 'p', 'The Vault migrates existing legacy plaintext settings and credentials into encrypted storage once. Legacy plaintext WebDAV files are not overwritten automatically; migration must be explicit. Forgotten passphrases cannot be recovered. This notice is not a claim of store compliance.')]);

        var form = make(document, 'form');
        var passphrase = make(document, 'input');
        passphrase.type = 'password';
        passphrase.autocomplete = 'new-password';
        passphrase.minLength = MIN_PASSPHRASE_LENGTH;
        passphrase.required = true;
        passphrase.id = 'vault-create-passphrase';
        var passLabel = make(document, 'label', 'New Vault passphrase (at least 12 characters)');
        passLabel.setAttribute('for', passphrase.id);
        var passField = make(document, 'div');
        passField.className = 'vault-passphrase-field';
        append(passField, [passLabel, passwordControl(document, passphrase)]);
        var risk = make(document, 'input');
        risk.type = 'checkbox';
        risk.required = true;
        var riskLabel = make(document, 'label', 'I understand: forgotten passphrases cannot be recovered, and legacy plaintext WebDAV files are not automatically overwritten.');
        riskLabel.insertBefore(risk, riskLabel.firstChild || null);
        var submit = make(document, 'button', 'Create and encrypt Vault');
        submit.type = 'submit';
        var message = make(document, 'p');
        message.setAttribute('role', 'status');
        append(form, [passField, riskLabel, securityNotice(document), submit, message]);
        activeSection.appendChild(form);

        form.addEventListener('submit', function(event) {
            event.preventDefault();
            if(passphrase.value.length < MIN_PASSPHRASE_LENGTH) {
                setText(message, 'The passphrase must be at least 12 characters.');
                return;
            }
            if(!risk.checked) {
                clearInput(passphrase);
                setText(message, 'Confirm the unrecoverable-passphrase risk before continuing.');
                return;
            }
            var operation = activeVault.create(passphrase.value);
            clearInput(passphrase);
            setBusy(form, true);
            setText(message, 'Creating encrypted Vault…');
            return operation.then(function() {
                renderUnlocked();
            }).catch(function(error) {
                return activeVault.isConfigured().then(function(configured) {
                    if(!configured) { setBusy(form, false); setText(message, (error && error.message) || 'Could not create the Vault.'); return; }
                    recoverPublication(error);
                }).catch(renderError);
            });
        });
    }

    function renderLocked() {
        var document = activeSection.ownerDocument;
        resetSection();
        append(activeSection, [make(document, 'h2', 'Vault locked on this page'), make(document, 'p', 'Authentication and sync on this page are paused. Locking clears persistent Vault root key material and requires the passphrase next time. Locking cannot revoke authentication cached by the browser or sessions maintained by a server.'), securityNotice(document)]);
        var form = make(document, 'form');
        var input = make(document, 'input');
        input.type = 'password';
        input.autocomplete = 'current-password';
        input.required = true;
        input.id = 'vault-unlock-passphrase';
        var label = make(document, 'label', 'Vault passphrase');
        label.setAttribute('for', input.id);
        var passField = make(document, 'div');
        passField.className = 'vault-passphrase-field';
        append(passField, [label, passwordControl(document, input)]);
        var submit = make(document, 'button', 'Unlock Vault');
        submit.type = 'submit';
        var message = make(document, 'p');
        message.setAttribute('role', 'status');
        append(form, [passField, securityNotice(document), submit, message]);
        activeSection.appendChild(form);
        form.addEventListener('submit', function(event) {
            event.preventDefault();
            if(!input.value) {
                setText(message, 'Enter the Vault passphrase.');
                return;
            }
            var operation = activeVault.unlock(input.value);
            clearInput(input);
            setBusy(form, true);
            setText(message, 'Unlocking…');
            return operation.then(function() {
                renderUnlocked();
            }).catch(function(error) {
                recoverPublication(error);
            });
        });
    }

    function recoverPublication(error) {
        if(error && error.recoveryLocked === false) { renderLockFailure(error); return; }
        if(activeVault.isUnlocked()) renderUnlocked(); else renderLocked();
        lockNotice.hidden = false;
        setText(lockNotice, (error && error.recoveryLocked === true ? Translator.translate('vault_recovery_notice') + ' ' : '') + Translator.translateText((error && error.message) || 'The operation failed.'));
    }

    function renderLockPending() {
        resetSection();
        append(activeSection, [make(activeSection.ownerDocument, 'h2', 'Revoking global unlock state'),
            make(activeSection.ownerDocument, 'p', 'This page has stopped using credentials and is confirming revocation across other pages, the background process and session keys. Global lock has not yet been confirmed.')]);
    }

    function renderLockFailure(error) {
        lockFailure = error;
        resetSection();
        lockNotice.hidden = false;
        setText(lockNotice, 'Global lock is incomplete: ' + ((error && error.message) || 'Global revocation could not be confirmed.'));
        var retry = make(activeSection.ownerDocument, 'button', 'Retry global lock');
        retry.type = 'button';
        retry.addEventListener('click', startLock);
        append(activeSection, [make(activeSection.ownerDocument, 'h2', 'Global lock is incomplete'),
            make(activeSection.ownerDocument, 'p', 'This page remains paused and will not restore credentials, but global cleanup may have left session or persistent Vault key material behind. Retry; do not use the extension until global lock succeeds.'), retry]);
    }

    function startLock() {
        if(lockPending) return Promise.resolve();
        lockPending = true;
        lockFailure = null;
        lockNotice.hidden = true;
        setText(lockNotice, '');
        renderLockPending();
        var operation;
        try { operation = activeVault.lock(); } catch(error) { operation = Promise.reject(error); }
        return Promise.resolve(operation).then(function() {
            lockPending = false;
            renderLocked();
        }, function(error) {
            lockPending = false;
            renderLockFailure(error);
        });
    }

    function renderUnlocked() {
        if(!activeSection) return;
        var document = activeSection.ownerDocument;
        lockNotice.hidden = true;
        setText(lockNotice, '');
        resetSection();
        var lock = make(document, 'button', 'Lock Vault');
        lock.type = 'button';
        var status = make(document, 'p', 'The Vault is unlocked. Authentication and sync can run.');
        lock.addEventListener('click', startLock);
        append(activeSection, [make(document, 'h2', 'Vault unlocked'), status, securityNotice(document), lock]);
    }

    function setBusy(form, busy) {
        var controls = form.querySelectorAll('input, button');
        for(var i = 0; i < controls.length; i++) controls[i].disabled = busy;
    }

    return { init: init, _unsubscribe: function() { if(lockUnsubscribe) lockUnsubscribe(); if(unlockUnsubscribe) unlockUnsubscribe(); } };
}

module.exports = new VaultUI();
