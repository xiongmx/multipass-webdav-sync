'use strict';

var CredentialStorage = require('./credential_storage');
var Storage = require('./storage');
var Translator = require('./translator');

module.exports = function() {
    var password_stars_class = 'password-stars';
    var password_real_class = 'password-real';

    var storage_key = 'temporary-credentials';

    function sanitize_credential(credential) {
        var fields = ['url', 'username', 'password', 'priority'];
        var result = {};

        for(var f in fields) {
            if (Object.prototype.hasOwnProperty.call(fields, f) && Object.prototype.hasOwnProperty.call(credential, fields[f])) {
                result[fields[f]] = credential[fields[f]];
            }
        }

        return result;
    }

    function display_credentials(credentials) {
        var container = document.getElementsByClassName('credentials')[0];
        container.replaceChildren();

        credentials = Object.keys(credentials).map(function(e) {
            return credentials[e];
        });
        credentials.sort(CredentialStorage.sortCredentials);

        for (var key in credentials) {
            if (Object.prototype.hasOwnProperty.call(credentials, key)) {
                var c = sanitize_credential(credentials[key]);
                var url = typeof c.url === 'string' ? c.url : '';
                var username = typeof c.username === 'string' ? c.username : '';
                var password = typeof c.password === 'string' ? c.password : '';
                var row = document.createElement('tr');
                var urlCell = document.createElement('td');
                urlCell.className = 'url';
                urlCell.title = url;
                var urlLabel = document.createElement('span');
                urlLabel.className = 'mobile-field-label';
                urlLabel.textContent = Translator.translate('url_regexp');
                urlCell.appendChild(urlLabel);
                urlCell.appendChild(document.createTextNode(url));
                row.appendChild(urlCell);

                var usernameCell = document.createElement('td');
                usernameCell.className = 'username';
                usernameCell.title = username;
                var usernameLabel = document.createElement('span');
                usernameLabel.className = 'mobile-field-label';
                usernameLabel.textContent = Translator.translate('username');
                usernameCell.appendChild(usernameLabel);
                usernameCell.appendChild(document.createTextNode(username));
                row.appendChild(usernameCell);

                var passwordCell = document.createElement('td');
                passwordCell.className = 'password';
                var passwordLabel = document.createElement('span');
                passwordLabel.className = 'mobile-field-label';
                passwordLabel.textContent = Translator.translate('password');
                passwordCell.appendChild(passwordLabel);
                var passwordStars = document.createElement('span');
                passwordStars.className = password_stars_class;
                passwordStars.textContent = '***';
                passwordCell.appendChild(passwordStars);
                var passwordReal = document.createElement('span');
                passwordReal.className = password_real_class;
                passwordReal.textContent = password;
                passwordCell.appendChild(passwordReal);
                var showPassword = document.createElement('button');
                showPassword.type = 'button';
                showPassword.className = 'show-password';
                showPassword.textContent = Translator.translate('show_hide_password');
                passwordCell.appendChild(showPassword);
                row.appendChild(passwordCell);

                var priorityCell = document.createElement('td');
                priorityCell.className = 'priority';
                var priorityLabel = document.createElement('span');
                priorityLabel.className = 'mobile-field-label';
                priorityLabel.textContent = Translator.translate('priority');
                priorityCell.appendChild(priorityLabel);
                priorityCell.appendChild(document.createTextNode(String(c.priority || 1)));
                row.appendChild(priorityCell);

                var actionCell = document.createElement('td');
                actionCell.className = 'action';
                var removeButton = document.createElement('button');
                removeButton.type = 'button';
                removeButton.className = 'remove';
                removeButton.setAttribute('data-url', url);
                removeButton.textContent = Translator.translate('remove_credential');
                actionCell.appendChild(removeButton);
                var editButton = document.createElement('button');
                editButton.type = 'button';
                editButton.className = 'edit';
                editButton.setAttribute('data-url', url);
                editButton.textContent = Translator.translate('edit_credential');
                actionCell.appendChild(editButton);
                row.appendChild(actionCell);

                container.appendChild(row);
            }
        }
    }

    function togglePassword(e) {
        var password = e.target.parentNode;
        var star = password.getElementsByClassName(password_stars_class)[0];
        var real = password.getElementsByClassName(password_real_class)[0];

        var password_shown = star.style.display == 'none';
        star.style.display = password_shown ? 'inline' : 'none';
        real.style.display = password_shown ? 'none' : 'inline';
    }

    function submit(e) {
        e.preventDefault();

        var url = document.getElementById('url');
        var username = document.getElementById('username');
        var password = document.getElementById('password');
        var priority = document.getElementById('priority');

        var values = {
            url: url.value,
            username: username.value,
            password: password.value,
            priority: priority.value
        };

        var valid = true;
        for (var key in values) {
            if (Object.prototype.hasOwnProperty.call(values, key)) {
                var v = values[key];

                if(v === '') {
                    valid = false;
                }
            }
        }

        if(valid) {
            var old = document.querySelector('tr.editing .url');
            var oldUrl = old && old.innerText.length > 0 ? old.innerText : undefined;
            CredentialStorage.saveCredential(values, oldUrl).then(function() {
                url.value = '';
                username.value = '';
                password.value = '';
                priority.value = 1;
                reset_form();
            }).catch(function() {});
        }
    }

    function remove(e) {
        var url = e.target.getAttribute('data-url');
        CredentialStorage.removeCredential(url).catch(function() {});
    }

    function edit(e) {
        reset_form();

        var url = document.getElementById('url');
        var username = document.getElementById('username');
        var password = document.getElementById('password');
        var priority = document.getElementById('priority');

        var tr = e.target.closest('tr');

        tr.classList.add('editing');

        url.value = tr.getElementsByClassName('url')[0].textContent;
        username.value = tr.getElementsByClassName('username')[0].textContent;
        password.value = tr.getElementsByClassName('password-real')[0].textContent;
        priority.value = tr.getElementsByClassName('priority')[0].textContent;

        document.getElementsByClassName('credential-form-submit')[0].textContent = Translator.translate('edit_credential');
    }

    function reset_form() {
        var el = document.querySelector('tr.editing');
        if(el) el.classList.remove('editing');

        document.getElementsByClassName('credential-form-submit')[0].textContent = Translator.translate('add_credential');
    }

    function init() {
        CredentialStorage.register(display_credentials);

        document.getElementById('credential-form').addEventListener('submit', submit);

        document.addEventListener('click', function(e) {
            if(e.target.matches('.credential-form-reset')) {
                e.stopPropagation();
                reset_form(e);
            }
            if(e.target.matches('.remove')) {
                e.stopPropagation();
                remove(e);
            }
            if(e.target.matches('.edit')) {
                e.stopPropagation();
                edit(e);
            }
            if(e.target.matches('.show-password')) {
                e.stopPropagation();
                togglePassword(e);
            }
        });

        Storage.getAsync(storage_key, {}).then(function(result) {
            result = result && typeof result === 'object' ? result : {};
            document.getElementById('url').value = result.url || '';
            document.getElementById('username').value = result.username || '';
            document.getElementById('password').value = result.password || '';
            document.getElementById('priority').value = result.priority || 1;
            return Storage.setAsync(storage_key, {});
        }).catch(function() {});

        addEventListener('unload', function () {
            var url = document.getElementById('url').value;
            var username = document.getElementById('username').value;
            var password = document.getElementById('password').value;
            var priority = document.getElementById('priority').value;

            var values = {
                url: url,
                username: username,
                password: password,
                priority: priority
            };
            Storage.setAsync(storage_key, values).catch(function() {});
        });
    }

    return {
        'init': init,
        'sanitize_credential': sanitize_credential
    };
}();
