/*global Promise*/
'use strict';

var Credentials = require('./credentials');
var CredentialStorage = require('./credential_storage');
var Vault = require('./vault');
var VaultUI = require('./vault_ui');
var Storage = require('./storage');
var Translator = require('./translator');
var WebDAVSync = require('./webdav_sync');
var AuthPolicy = require('./auth_policy');

var OptionPanel = (function() {
    var imported = [];
    var importOutput, importFile, importText, storageStatus;
    var importEpoch = 0;
    var downloadUrls = [];

    function showStorageError() {
        storageStatus.textContent = Vault.isUnlocked() ?
            'Local storage failed. Your changes may not have been saved.' : 'Unlock the vault before accessing credentials.';
        storageStatus.hidden = false;
        storageStatus.className = 'webdav-status error';
    }
    function clearStorageError() {
        storageStatus.textContent = '';
        storageStatus.hidden = true;
    }
    function modal(title, content, confirmation) {
        var overlay = document.getElementsByClassName('overlay')[0].cloneNode(true);
        overlay.removeAttribute('style');
        [].forEach.call(overlay.querySelectorAll('button, .close-button'), function(el) {
            el.addEventListener('click', function() {
                overlay.classList.add('transparent');
                setTimeout(function() { if(overlay.parentNode) overlay.parentNode.removeChild(overlay); }, 1000);
            });
        });
        overlay.querySelector('.modal-confirm').addEventListener('click', confirmation);
        overlay.querySelector('.overlay-title').textContent = title;
        overlay.querySelector('.overlay-content').textContent = content;
        overlay.querySelector('.page').addEventListener('click', function(e) { e.stopPropagation(); });
        document.body.appendChild(overlay);
    }
    function credentialList(value) {
        if(Array.isArray(value)) return value;
        if(value && Array.isArray(value.credentials)) return value.credentials;
        if(value && value.credentials && typeof value.credentials === 'object') return credentialList(value.credentials);
        if(value && typeof value === 'object') {
            var keys = Object.keys(value);
            if(keys.every(function(key) { return value[key] && typeof value[key].url === 'string'; })) {
                return keys.map(function(key) { return value[key]; });
            }
        }
        throw new Error('Invalid credential file.');
    }
    function renderPreview() {
        var ul = document.createElement('ul');
        imported.forEach(function(raw) {
            var c = Credentials.sanitize_credential(raw);
            var item = document.createElement('li');
            item.textContent = [c.url, ' : ', c.username, ' - *** - ', c.priority].join('');
            ul.appendChild(item);
        });
        importOutput.replaceChildren(ul);
    }
    function rejectedImport() {
        importOutput.textContent = 'Import rejected. Unlock the vault and use a valid encrypted export/backup with the same passphrase.';
    }
    function addPayload(text, epoch) {
        if(!Vault.isUnlocked() || epoch !== importEpoch) return Promise.reject(new Error('Vault is locked.'));
        var payload;
        try { payload = JSON.parse(text); } catch(error) { return Promise.reject(new Error('Invalid JSON.')); }
        var decoded;
        if(payload && payload.format === 'multipass-vault-v1' && (payload.kind === 'export' || payload.kind === 'backup')) {
            decoded = Vault.decrypt(payload, payload.kind);
        } else {
            if(!window.confirm('这是旧明文文件。仅在你确认来源可信时导入；导入后将加密保存在保险库中。原文件不会自动删除，请另行清理。继续一次性迁移？')) {
                return Promise.reject(new Error('Migration cancelled.'));
            }
            decoded = Promise.resolve(payload);
        }
        return decoded.then(function(value) {
            if(!Vault.isUnlocked() || epoch !== importEpoch) throw new Error('Vault is locked.');
            imported = imported.concat(credentialList(value));
            renderPreview();
        });
    }
    function importFiles(e) {
        if(!Vault.isUnlocked()) { rejectedImport(); return; }
        [].forEach.call(e.target.files, function(file) {
            if(file.size > 5 * 1024 * 1024) { rejectedImport(); return; }
            var epoch = importEpoch;
            var reader = new FileReader();
            reader.onload = function(event) { addPayload(event.target.result, epoch).catch(rejectedImport); };
            reader.onerror = rejectedImport;
            reader.readAsText(file);
        });
    }
    function importJSON() { addPayload(importText.value, importEpoch).catch(rejectedImport); }
    function clearImport() {
        importEpoch++;
        imported = [];
        importFile.value = '';
        importText.value = '';
        importOutput.replaceChildren();
    }
    function importCredentials(e) {
        e.preventDefault();
        if(!Vault.isUnlocked()) { rejectedImport(); return; }
        CredentialStorage.addCredentials(imported).then(clearImport).catch(rejectedImport);
    }
    function testRegex() {
        var regex = document.getElementById('test-regex').value;
        [].forEach.call(document.querySelectorAll('#test-urls li'), function(el) {
            el.classList.toggle('matched', AuthPolicy.matchesRule(regex, el.textContent.trim()));
        });
    }
    function restoreTestInput() {
        if(document.querySelectorAll('#test-urls li').length === 0) {
            var item = document.createElement('li');
            item.textContent = 'https://example.com';
            document.getElementById('test-urls').replaceChildren(item);
        }
        testRegex();
    }
    function releaseDownloads() {
        downloadUrls.forEach(function(url) { URL.revokeObjectURL(url); });
        downloadUrls = [];
    }
    function exportCredentials(e) {
        e.preventDefault();
        if(!Vault.isUnlocked()) { showStorageError(); return; }
        var epoch = importEpoch;
        Vault.encrypt(credentialList(JSON.parse(CredentialStorage.asJSON())), 'export').then(function(envelope) {
            if(!Vault.isUnlocked() || epoch !== importEpoch) return;
            var url = URL.createObjectURL(new Blob([JSON.stringify(envelope)], { type: 'application/json;charset=utf-8' }));
            downloadUrls.push(url);
            var link = document.createElement('a');
            link.href = url;
            link.download = 'multipass-encrypted-credentials.json';
            document.body.appendChild(link);
            link.click();
            link.remove();
            setTimeout(function() {
                URL.revokeObjectURL(url);
                downloadUrls = downloadUrls.filter(function(active) { return active !== url; });
            }, 1000);
        }).catch(showStorageError);
    }
    function clearCredentials(e) {
        e.preventDefault();
        modal(Translator.translate('clear_credentials_modal_title'), Translator.translate('clear_credentials_modal_text'), function(event) {
            event.preventDefault();
            CredentialStorage.clearAll().catch(showStorageError);
        });
    }
    function init() {
        importOutput = document.querySelector('output.import-list');
        importFile = document.getElementById('import-file');
        importText = document.getElementById('import-json');
        storageStatus = document.getElementById('storage-status');
        Storage.onError(showStorageError);
        Storage.onSuccess(clearStorageError);
        importFile.addEventListener('change', importFiles);
        importText.addEventListener('change', importJSON);
        document.querySelector('button.import-submit').addEventListener('click', importCredentials);
        document.getElementById('test-urls').addEventListener('blur', restoreTestInput);
        document.getElementById('test-urls').addEventListener('keyup', testRegex);
        document.getElementById('test-regex').addEventListener('keyup', testRegex);
        document.querySelector('a.export-credentials').addEventListener('click', exportCredentials);
        document.querySelector('button.clear-all').addEventListener('click', clearCredentials);
        document.getElementsByClassName('multipass-version')[0].textContent = chrome.runtime.getManifest().version;
        Vault.onLock(function() { clearImport(); releaseDownloads(); });
    }
    return { init: init };
}());

document.addEventListener('DOMContentLoaded', function() {
    VaultUI.init();
    OptionPanel.init();
    Credentials.init();
    WebDAVSync.init(CredentialStorage);
});
