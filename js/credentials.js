'use strict';
var CredentialStorage = require('./credential_storage');
var Storage = require('./storage');
var Vault = require('./vault');
var Translator = require('./translator');
var AuthPolicy = require('./auth_policy');
module.exports = function() {
    var stars = 'password-stars', real = 'password-real', temporary = 'temporary-credentials', unloading = false;
    function sanitize_credential(c) { var r = {}; ['url', 'username', 'password', 'priority'].forEach(function(k) { if(c && Object.prototype.hasOwnProperty.call(c, k)) r[k] = c[k]; }); return r; }
    function display_credentials(value) {
        var container = document.getElementsByClassName('credentials')[0]; if(!container) return; container.replaceChildren();
        var list = Object.keys(value || {}).map(function(k) { return value[k]; }).sort(CredentialStorage.sortCredentials);
        list.forEach(function(raw) {
            var c = sanitize_credential(raw), url = typeof c.url === 'string' ? c.url : '', username = typeof c.username === 'string' ? c.username : '';
            var row = document.createElement('tr'), urlCell = document.createElement('td'); urlCell.className = 'url'; urlCell.title = url; urlCell.textContent = url; row.appendChild(urlCell);
            var usernameCell = document.createElement('td'); usernameCell.className = 'username'; usernameCell.title = username; usernameCell.textContent = username; row.appendChild(usernameCell);
            var passwordCell = document.createElement('td'); passwordCell.className = 'password'; passwordCell.setAttribute('data-url', url);
            var passwordStars = document.createElement('span'); passwordStars.className = stars; passwordStars.textContent = '***'; passwordCell.appendChild(passwordStars);
            var passwordReal = document.createElement('span'); passwordReal.className = real; passwordReal.textContent = ''; passwordReal.style.display = 'none'; passwordCell.appendChild(passwordReal);
            var show = document.createElement('button'); show.type = 'button'; show.className = 'show-password'; show.textContent = Translator.translate('show_hide_password'); passwordCell.appendChild(show); row.appendChild(passwordCell);
            var priorityCell = document.createElement('td'); priorityCell.className = 'priority'; priorityCell.textContent = String(c.priority === undefined ? 1 : c.priority); row.appendChild(priorityCell);
            var action = document.createElement('td'); action.className = 'action';
            var remove = document.createElement('button'); remove.type = 'button'; remove.className = 'remove'; remove.setAttribute('data-url', url); remove.textContent = Translator.translate('remove_credential'); action.appendChild(remove);
            var edit = document.createElement('button'); edit.type = 'button'; edit.className = 'edit'; edit.setAttribute('data-url', url); edit.textContent = Translator.translate('edit_credential'); action.appendChild(edit); row.appendChild(action); container.appendChild(row);
        });
    }
    function clearSensitiveForm() {
        ['url', 'username', 'password', 'priority'].forEach(function(id) { var el = document.getElementById(id); if(el) el.value = id === 'url' ? AuthPolicy.DEFAULT_RULE : id === 'priority' ? 1 : ''; });
        [].forEach.call(document.getElementsByClassName(real), function(el) { el.textContent = ''; el.style.display = 'none'; });
        [].forEach.call(document.getElementsByClassName(stars), function(el) { el.style.display = 'inline'; });
        reset_form();
    }
    function togglePassword(e) {
        if(!Vault.isUnlocked()) return;
        var cell = e.target.parentNode, star = cell.getElementsByClassName(stars)[0], shown = cell.getElementsByClassName(real)[0];
        if(shown.style.display !== 'none') { shown.textContent = ''; shown.style.display = 'none'; star.style.display = 'inline'; return; }
        var c = CredentialStorage.getCredential(cell.getAttribute('data-url')); if(!c) return;
        shown.textContent = c.password; shown.style.display = 'inline'; star.style.display = 'none';
    }
    function submit(e) {
        e.preventDefault(); if(!Vault.isUnlocked()) { clearSensitiveForm(); return; }
        var url = document.getElementById('url'), username = document.getElementById('username'), password = document.getElementById('password'), priority = document.getElementById('priority');
        if(url.value === AuthPolicy.DEFAULT_RULE) { if(typeof window !== 'undefined' && window.alert) window.alert(Translator.translate('site_rule_default_notice')); return; }
        var values = { url: url.value, username: username.value, password: password.value, priority: priority.value }; if(!values.url) return;
        var old = document.querySelector('tr.editing .url'), oldUrl = old && old.textContent ? old.textContent : undefined;
        CredentialStorage.saveCredential(values, oldUrl).then(function() { clearSensitiveForm(); }).catch(function() {});
    }
    function remove(e) { if(Vault.isUnlocked()) CredentialStorage.removeCredential(e.target.getAttribute('data-url')).catch(function() {}); }
    function edit(e) {
        if(!Vault.isUnlocked()) return; reset_form(); var target = e.target, rule = target.getAttribute('data-url'), c = CredentialStorage.getCredential(rule); if(!c) return;
        var row = target.closest('tr'); row.classList.add('editing'); document.getElementById('url').value = c.url; document.getElementById('username').value = c.username; document.getElementById('password').value = c.password; document.getElementById('priority').value = c.priority; document.getElementsByClassName('credential-form-submit')[0].textContent = Translator.translate('edit_credential');
    }
    function reset_form() { var editing = document.querySelector('tr.editing'); if(editing) editing.classList.remove('editing'); var url = document.getElementById('url'); if(url && Vault.isUnlocked()) url.value = AuthPolicy.DEFAULT_RULE; var submitButton = document.getElementsByClassName('credential-form-submit')[0]; if(submitButton) submitButton.textContent = Translator.translate('add_credential'); }
    function restoreTemporary() { if(!Vault.isUnlocked()) return; Storage.getAsync(temporary, {}).then(function(result) { result = result && typeof result === 'object' ? result : {}; var url = document.getElementById('url'); if(url) url.value = result.url || AuthPolicy.DEFAULT_RULE; document.getElementById('username').value = typeof result.username === 'string' ? result.username : ''; document.getElementById('password').value = typeof result.password === 'string' ? result.password : ''; document.getElementById('priority').value = result.priority || 1; return Storage.setAsync(temporary, {}); }).catch(function() {}); }
    function init() {
        CredentialStorage.register(display_credentials); var form = document.getElementById('credential-form'); if(form) form.addEventListener('submit', submit);
        document.addEventListener('click', function(e) { if(e.target.matches('.credential-form-reset')) { e.stopPropagation(); clearSensitiveForm(); } if(e.target.matches('.remove')) { e.stopPropagation(); remove(e); } if(e.target.matches('.edit')) { e.stopPropagation(); edit(e); } if(e.target.matches('.show-password')) { e.stopPropagation(); togglePassword(e); } });
        restoreTemporary(); if(typeof Vault.onLock === 'function') Vault.onLock(function() { unloading = true; clearSensitiveForm(); }); if(typeof Vault.onUnlock === 'function') Vault.onUnlock(function() { unloading = false; restoreTemporary(); });
        addEventListener('unload', function() { if(unloading || !Vault.isUnlocked()) return; Storage.setAsync(temporary, { url: document.getElementById('url').value, username: document.getElementById('username').value, password: document.getElementById('password').value, priority: document.getElementById('priority').value }).catch(function() {}); });
    }
    return { init: init, sanitize_credential: sanitize_credential };
}();
