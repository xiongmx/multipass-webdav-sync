/*global Promise*/
'use strict';

var Vault = require('./vault');

var MIN_PASSPHRASE_LENGTH = 12;
var SECTION_ID = 'vault-ui';

function make(document, tag, text) {
    var element = document.createElement(tag);
    if(text !== undefined) element.textContent = text;
    return element;
}

function append(parent, children) {
    children.forEach(function(child) { parent.appendChild(child); });
    return parent;
}

function setText(element, text) {
    element.textContent = text;
}

function clearInput(input) {
    if(input) input.value = '';
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
        document.body.insertBefore(activeSection, document.body.firstChild || null);
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
            renderError(error);
        });
        return activeSection;
    }

    function resetSection() {
        while(activeSection.firstChild) activeSection.removeChild(activeSection.firstChild);
        if(lockNotice) activeSection.appendChild(lockNotice);
    }

    function renderLoading() {
        resetSection();
        append(activeSection, [make(activeSection.ownerDocument, 'h2', '保险库'), make(activeSection.ownerDocument, 'p', '正在检查保险库状态…')]);
    }

    function renderError(error) {
        resetSection();
        append(activeSection, [make(activeSection.ownerDocument, 'h2', '保险库'), make(activeSection.ownerDocument, 'p', '无法读取保险库状态：' + ((error && error.message) || '未知错误'))]);
    }

    function renderSetup() {
        var document = activeSection.ownerDocument;
        resetSection();
        append(activeSection, [make(document, 'h2', '设置加密保险库'), make(document, 'p', '保险库会把现有旧明文设置和凭据一次性迁入加密存储。旧 WebDAV 明文文件不会自动覆盖，之后需要显式迁移。忘记口令无法恢复。此提示不构成任何商店合规保证。')]);

        var form = make(document, 'form');
        var passphrase = make(document, 'input');
        var confirmation = make(document, 'input');
        passphrase.type = 'password';
        confirmation.type = 'password';
        passphrase.autocomplete = 'new-password';
        confirmation.autocomplete = 'new-password';
        passphrase.minLength = MIN_PASSPHRASE_LENGTH;
        confirmation.minLength = MIN_PASSPHRASE_LENGTH;
        passphrase.required = true;
        confirmation.required = true;
        var passLabel = make(document, 'label', '新保险库口令（至少12个字符）');
        var confirmLabel = make(document, 'label', '再次输入保险库口令');
        passLabel.appendChild(passphrase);
        confirmLabel.appendChild(confirmation);
        var risk = make(document, 'input');
        risk.type = 'checkbox';
        risk.required = true;
        var riskLabel = make(document, 'label', '我理解：忘记口令无法恢复，且旧 WebDAV 明文文件不会自动覆盖。');
        riskLabel.insertBefore(risk, riskLabel.firstChild || null);
        var submit = make(document, 'button', '创建并加密保险库');
        submit.type = 'submit';
        var message = make(document, 'p');
        message.setAttribute('role', 'status');
        append(form, [passLabel, confirmLabel, riskLabel, submit, message]);
        activeSection.appendChild(form);

        form.addEventListener('submit', function(event) {
            event.preventDefault();
            if(passphrase.value.length < MIN_PASSPHRASE_LENGTH) {
                setText(message, '口令至少需要12个字符。');
                return;
            }
            if(passphrase.value !== confirmation.value) {
                clearInput(passphrase);
                clearInput(confirmation);
                setText(message, '两次输入的口令不一致。');
                return;
            }
            if(!risk.checked) {
                clearInput(passphrase);
                clearInput(confirmation);
                setText(message, '请先勾选不可恢复风险确认。');
                return;
            }
            var operation = activeVault.create(passphrase.value);
            clearInput(passphrase);
            clearInput(confirmation);
            setBusy(form, true);
            setText(message, '正在创建加密保险库…');
            return operation.then(function() {
                renderUnlocked();
            }).catch(function(error) {
                return activeVault.isConfigured().then(function(configured) {
                    if(!configured) { setBusy(form, false); setText(message, (error && error.message) || '创建保险库失败。'); return; }
                    recoverPublication(error);
                }).catch(renderError);
            });
        });
    }

    function renderLocked() {
        var document = activeSection.ownerDocument;
        resetSection();
        append(activeSection, [make(document, 'h2', '本页保险库已锁定'), make(document, 'p', '本页认证和同步已暂停。锁定不能撤销浏览器已缓存的认证或服务端会话。')]);
        var form = make(document, 'form');
        var input = make(document, 'input');
        input.type = 'password';
        input.autocomplete = 'current-password';
        input.required = true;
        var label = make(document, 'label', '保险库口令');
        label.appendChild(input);
        var submit = make(document, 'button', '解锁保险库');
        submit.type = 'submit';
        var message = make(document, 'p');
        message.setAttribute('role', 'status');
        append(form, [label, submit, message]);
        activeSection.appendChild(form);
        form.addEventListener('submit', function(event) {
            event.preventDefault();
            if(!input.value) {
                setText(message, '请输入保险库口令。');
                return;
            }
            var operation = activeVault.unlock(input.value);
            clearInput(input);
            setBusy(form, true);
            setText(message, '正在解锁…');
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
        setText(lockNotice, (error && error.recoveryLocked === true ? '加密保险库和迁移数据已保留，本次解锁未完成；请用同一口令解锁。' : '') + ((error && error.message) || '操作失败。'));
    }

    function renderLockPending() {
        resetSection();
        append(activeSection, [make(activeSection.ownerDocument, 'h2', '正在撤销全局解锁状态'),
            make(activeSection.ownerDocument, 'p', '本页已停止使用凭据，正在确认其他页面、后台和会话密钥的撤销。尚未确认全局锁定成功。')]);
    }

    function renderLockFailure(error) {
        lockFailure = error;
        resetSection();
        lockNotice.hidden = false;
        setText(lockNotice, '全局锁定未完成：' + ((error && error.message) || '无法确认全局撤销。'));
        var retry = make(activeSection.ownerDocument, 'button', '重试全局锁定');
        retry.type = 'button';
        retry.addEventListener('click', startLock);
        append(activeSection, [make(activeSection.ownerDocument, 'h2', '全局锁定未完成'),
            make(activeSection.ownerDocument, 'p', '本页保持暂停且不恢复凭据，但不能把当前页面状态当作其他页面、后台或会话密钥已清除的证明。请重试；未成功前不要继续使用扩展。'), retry]);
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
        var lock = make(document, 'button', '锁定保险库');
        lock.type = 'button';
        var status = make(document, 'p', '保险库已解锁。认证和同步可以运行。');
        lock.addEventListener('click', startLock);
        append(activeSection, [make(document, 'h2', '保险库已解锁'), status, lock]);
    }

    function setBusy(form, busy) {
        var controls = form.querySelectorAll('input, button');
        for(var i = 0; i < controls.length; i++) controls[i].disabled = busy;
    }

    return { init: init, _unsubscribe: function() { if(lockUnsubscribe) lockUnsubscribe(); if(unlockUnsubscribe) unlockUnsubscribe(); } };
}

module.exports = new VaultUI();
