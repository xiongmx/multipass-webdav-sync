/*global Promise, Uint8Array, globalThis*/
'use strict';

var WebDAVSync = function() {
    var SETTINGS_KEY = 'multipassWebdavSettings';
    var META_KEY = 'multipassWebdavSyncMeta';
    var BACKUPS_KEY = 'multipassWebdavBackups';
    var AUTO_STATUS_KEY = 'multipassWebdavAutoStatus';
    var ALARM_NAME = 'multipass-webdav-auto-sync';
    var SYNC_FORMAT = 'multipass-webdav-plain-v1';
    var LEGACY_ENCRYPTED_FORMAT = 'multipass-webdav-encrypted-v1';
    var MAX_REMOTE_FILE_BYTES = 5 * 1024 * 1024;
    var credentialStorage;
    var statusElement;
    var pullButton;
    var pushButton;
    var backupButton;
    var saveButton;
    var syncButton;
    var intervalSelect;
    var operationInProgress = false;
    var backupAvailable = false;
    var backgroundInitialized = false;
    var automaticRun = null;

    function setStatus(message, isError) {
        if(!statusElement) return;
        statusElement.textContent = message;
        statusElement.className = isError ? 'webdav-status error' : 'webdav-status';
    }

    function setOperationBusy(isBusy) {
        [saveButton, syncButton, pullButton, pushButton].forEach(function(button) {
            if(button) button.disabled = isBusy;
        });
        if(backupButton) backupButton.disabled = isBusy || !backupAvailable;
    }

    function runExclusive(operation) {
        if(operationInProgress) return Promise.resolve();
        operationInProgress = true;
        setOperationBusy(true);
        return Promise.resolve().then(operation).catch(function(error) {
            setStatus(error.message || 'WebDAV operation failed.', true);
        }).then(function() {
            operationInProgress = false;
            setOperationBusy(false);
        });
    }

    function localGet(keys) {
        return new Promise(function(resolve, reject) {
            chrome.storage.local.get(keys, function(result) {
                var error = chrome.runtime && chrome.runtime.lastError;
                if(error) reject(new Error(error.message || String(error)));
                else resolve(result || {});
            });
        });
    }

    function localSet(values) {
        return new Promise(function(resolve, reject) {
            chrome.storage.local.set(values, function() {
                var error = chrome.runtime && chrome.runtime.lastError;
                if(error) reject(new Error(error.message || String(error)));
                else resolve();
            });
        });
    }

    function validateEndpoint(endpoint) {
        var parsed;
        try {
            parsed = new URL(endpoint);
        } catch(e) {
            throw new Error('Enter a valid HTTPS WebDAV file URL.');
        }

        var isLoopback = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]';
        if(parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopback)) {
            throw new Error('HTTPS is required. Plain HTTP is allowed only for localhost testing.');
        }
        if(parsed.username || parsed.password) {
            throw new Error('Do not put a username or password in the URL; use the separate fields.');
        }
        if(parsed.search) throw new Error('Do not put authentication data or tokens in the URL query; use the separate fields.');
        if(parsed.hash) throw new Error('The WebDAV URL must not contain a fragment.');
        return parsed.href;
    }

    function getLocalCredentials() {
        try {
            return JSON.parse(credentialStorage.asJSON());
        } catch(e) {
            throw new Error('Could not read the local credentials.');
        }
    }

    function normalizeCredentials(input) {
        var result = Object.create(null);
        var items = Array.isArray(input) ? input : Object.keys(input || {}).map(function(key) { return input[key]; });
        items.forEach(function(item) {
            if(!item || typeof item.url !== 'string' || item.url.length === 0 || typeof item.username !== 'string' || typeof item.password !== 'string') {
                throw new Error('The WebDAV file contains an invalid credential entry.');
            }
            var allowedCredentialFields = ['url', 'username', 'password', 'priority'];
            if(Object.keys(item).some(function(key) { return allowedCredentialFields.indexOf(key) === -1; })) {
                throw new Error('The WebDAV file contains unknown credential fields.');
            }
            result[item.url] = {
                url: item.url,
                username: item.username,
                password: item.password,
                priority: typeof item.priority === 'undefined' ? '1' : String(item.priority)
            };
        });
        return result;
    }

    function stableCredentials(input) {
        var normalized = normalizeCredentials(input);
        var result = Object.create(null);
        Object.keys(normalized).sort().forEach(function(key) {
            var item = normalized[key];
            result[key] = {
                url: item.url,
                username: item.username,
                password: item.password,
                priority: item.priority
            };
        });
        return result;
    }

    function encodeText(text) {
        return new TextEncoder().encode(text);
    }

    function bytesToBase64(bytes) {
        var binary = '';
        for(var i = 0; i < bytes.length; i += 0x8000) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + 0x8000, bytes.length)));
        }
        return btoa(binary);
    }

    function fingerprint(credentials) {
        if(!globalThis.crypto || !globalThis.crypto.subtle) {
            return Promise.reject(new Error('This browser does not provide Web Crypto for sync revision checks.'));
        }
        var bytes = encodeText(JSON.stringify(stableCredentials(credentials)));
        return globalThis.crypto.subtle.digest('SHA-256', bytes).then(function(hash) {
            return bytesToBase64(new Uint8Array(hash));
        });
    }

    function fingerprintText(text) {
        if(!globalThis.crypto || !globalThis.crypto.subtle) {
            return Promise.reject(new Error('This browser does not provide Web Crypto for sync revision checks.'));
        }
        return globalThis.crypto.subtle.digest('SHA-256', encodeText(text)).then(function(hash) {
            return bytesToBase64(new Uint8Array(hash));
        });
    }

    function createSyncDocument(credentials, previousUpdatedAt) {
        var updatedAt = Date.now();
        if(Number.isFinite(Number(previousUpdatedAt))) updatedAt = Math.max(updatedAt, Number(previousUpdatedAt) + 1);
        return fingerprint(credentials).then(function(revision) {
            return {
                format: SYNC_FORMAT,
                schema: 1,
                updatedAt: updatedAt,
                revision: revision,
                credentials: stableCredentials(credentials)
            };
        });
    }

    function parseSyncDocument(document) {
        if(document && document.format === LEGACY_ENCRYPTED_FORMAT) {
            return Promise.reject(new Error('This WebDAV file uses the retired encrypted format. Download a copy, then use Push local to replace it explicitly.'));
        }
        if(!document || document.format !== SYNC_FORMAT || document.schema !== 1 ||
            !Number.isSafeInteger(document.updatedAt) || document.updatedAt <= 0 ||
            typeof document.revision !== 'string' || !document.credentials || typeof document.credentials !== 'object' || Array.isArray(document.credentials)) {
            return Promise.reject(new Error('The WebDAV file has an unsupported or invalid format; no data was changed.'));
        }
        var allowedFields = ['format', 'schema', 'updatedAt', 'revision', 'credentials'];
        if(Object.keys(document).some(function(key) { return allowedFields.indexOf(key) === -1; })) {
            return Promise.reject(new Error('The WebDAV file contains unknown fields; no data was changed.'));
        }
        var credentials;
        try {
            credentials = normalizeCredentials(document.credentials);
        } catch(error) {
            return Promise.reject(error);
        }
        return fingerprint(credentials).then(function(actualRevision) {
            if(actualRevision !== document.revision) {
                throw new Error('The WebDAV file revision does not match its credentials; no data was changed.');
            }
            return {
                credentials: credentials,
                revision: actualRevision,
                updatedAt: document.updatedAt
            };
        });
    }

    function decideSync(state) {
        if(!state.remoteExists) return state.baselineEtag ? 'remote-deleted' : 'create';
        if(!state.remoteEtag || /^W\//i.test(state.remoteEtag)) return 'missing-etag';
        if(!state.baselineEtag || !state.baselineFingerprint || !state.baselineRemoteRevision || !state.baselineRemoteDocumentHash ||
            !Number.isSafeInteger(state.baselineRemoteUpdatedAt)) return 'first-connect';
        if(state.remoteEtag === state.baselineEtag &&
            (state.remoteRevision !== state.baselineRemoteRevision || state.remoteUpdatedAt !== state.baselineRemoteUpdatedAt ||
                state.remoteDocumentHash !== state.baselineRemoteDocumentHash)) {
            return 'etag-inconsistent';
        }
        var localChanged = state.localFingerprint !== state.baselineFingerprint;
        var remoteChanged = state.remoteEtag !== state.baselineEtag || state.remoteRevision !== state.baselineRemoteRevision ||
            state.remoteUpdatedAt !== state.baselineRemoteUpdatedAt || state.remoteDocumentHash !== state.baselineRemoteDocumentHash;
        if(localChanged && remoteChanged) return 'conflict';
        if(remoteChanged) return 'pull';
        if(localChanged) return 'push';
        return 'unchanged';
    }

    function basicAuthorization(username, password) {
        var bytes = encodeText(username + ':' + password);
        var binary = '';
        for(var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
        return 'Basic ' + btoa(binary);
    }

    function request(endpoint, settings, method, body, condition) {
        if(body && encodeText(body).byteLength > MAX_REMOTE_FILE_BYTES) {
            return Promise.reject(new Error('The WebDAV file exceeds the 5 MB safety limit.'));
        }
        var headers = {};
        if(settings.username || settings.password) {
            headers.Authorization = basicAuthorization(settings.username || '', settings.password || '');
        }
        if(body) headers['Content-Type'] = 'application/json; charset=utf-8';
        if(condition) headers[condition.name] = condition.value;
        return fetch(endpoint, {
            method: method,
            headers: headers,
            body: body || undefined,
            credentials: 'omit',
            cache: 'no-store',
            redirect: 'error'
        });
    }

    function readRemoteText(response) {
        if(response.body && typeof response.body.getReader === 'function') {
            var reader = response.body.getReader();
            var chunks = [];
            var totalBytes = 0;
            var readNext = function() {
                return reader.read().then(function(result) {
                    if(result.done) {
                        var bytes = new Uint8Array(totalBytes);
                        var offset = 0;
                        chunks.forEach(function(chunk) {
                            bytes.set(chunk, offset);
                            offset += chunk.byteLength;
                        });
                        return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
                    }
                    totalBytes += result.value.byteLength;
                    if(totalBytes > MAX_REMOTE_FILE_BYTES) {
                        return Promise.resolve(reader.cancel()).catch(function() {}).then(function() {
                            throw new Error('The WebDAV file exceeds the 5 MB safety limit.');
                        });
                    }
                    chunks.push(result.value);
                    return readNext();
                });
            };
            return readNext();
        }
        return response.text().then(function(text) {
            if(encodeText(text).byteLength > MAX_REMOTE_FILE_BYTES) throw new Error('The WebDAV file exceeds the 5 MB safety limit.');
            return text;
        });
    }

    function readRemote(settings) {
        return request(settings.endpoint, settings, 'GET').then(function(response) {
            if(response.status === 404 || response.status === 410) return { exists: false };
            if(response.status === 401 || response.status === 403) throw new Error('WebDAV authentication failed. Check the endpoint username and password.');
            if(!response.ok) throw new Error('WebDAV read failed (HTTP ' + response.status + ').');
            var etag = response.headers.get('ETag');
            var contentLength = Number(response.headers.get('Content-Length'));
            if(Number.isFinite(contentLength) && contentLength > MAX_REMOTE_FILE_BYTES) throw new Error('The WebDAV file exceeds the 5 MB safety limit.');
            return readRemoteText(response).then(function(text) {
                var document;
                try { document = JSON.parse(text); }
                catch(e) { throw new Error('The WebDAV file is not valid JSON.'); }
                return fingerprintText(text).then(function(contentHash) {
                    return { exists: true, etag: etag, document: document, contentHash: contentHash };
                });
            });
        });
    }

    function putRemote(settings, document, etag) {
        var condition = etag ? { name: 'If-Match', value: etag } : { name: 'If-None-Match', value: '*' };
        return request(settings.endpoint, settings, 'PUT', JSON.stringify(document), condition).then(function(response) {
            if(response.status === 412 || response.status === 409) {
                throw new Error('The server rejected the conditional write. Local data was retained; inspect both copies before syncing again.');
            }
            if(response.status === 401 || response.status === 403) throw new Error('WebDAV authentication failed. Check the endpoint username and password.');
            if(!response.ok) throw new Error('WebDAV write failed (HTTP ' + response.status + ').');
            var resultEtag = response.headers.get('ETag');
            if(resultEtag && !/^W\//i.test(resultEtag)) return resultEtag;
            throw new Error('The server accepted the write but did not return a strong ETag. Sync status is unknown; inspect the remote file before retrying.');
        });
    }

    function getSettings() {
        return localGet([SETTINGS_KEY, META_KEY]).then(function(result) {
            var settings = result[SETTINGS_KEY] || {};
            if(!settings.endpoint) throw new Error('Save a WebDAV URL before syncing.');
            settings.endpoint = validateEndpoint(settings.endpoint);
            settings.autoSyncIntervalMinutes = typeof settings.autoSyncIntervalMinutes === 'undefined' ? 0 : Number(settings.autoSyncIntervalMinutes);
            if(!Number.isInteger(settings.autoSyncIntervalMinutes) || settings.autoSyncIntervalMinutes < 0 || settings.autoSyncIntervalMinutes > 10080) {
                throw new Error('The saved automatic sync interval is invalid. Review the WebDAV settings.');
            }
            var meta = result[META_KEY] || {};
            if(meta.endpoint !== settings.endpoint || meta.authUsername !== (settings.username || '')) meta = {};
            return { settings: settings, meta: meta };
        });
    }

    function addBackup(label, credentials) {
        return localGet(BACKUPS_KEY).then(function(result) {
            var backups = Array.isArray(result[BACKUPS_KEY]) ? result[BACKUPS_KEY] : [];
            backups.unshift({ label: label, createdAt: Date.now(), credentials: stableCredentials(credentials) });
            var values = {};
            values[BACKUPS_KEY] = backups.slice(0, 3);
            return localSet(values).then(updateBackupButton);
        });
    }

    function addRemoteBackup(label, document) {
        return localGet(BACKUPS_KEY).then(function(result) {
            var backups = Array.isArray(result[BACKUPS_KEY]) ? result[BACKUPS_KEY] : [];
            backups.unshift({ label: label, createdAt: Date.now(), remoteDocument: document });
            var values = {};
            values[BACKUPS_KEY] = backups.slice(0, 3);
            return localSet(values).then(updateBackupButton);
        });
    }

    function setBaseline(etag, credentials, endpoint, document, remoteDocumentHash, username) {
        if(!remoteDocumentHash) return Promise.reject(new Error('Could not verify the remote file body; no sync baseline was saved.'));
        return fingerprint(credentials).then(function(digest) {
            var values = {};
            values[META_KEY] = {
                endpoint: endpoint,
                authUsername: username || '',
                etag: etag,
                fingerprint: digest,
                remoteRevision: document.revision,
                remoteUpdatedAt: document.updatedAt,
                remoteDocumentHash: remoteDocumentHash,
                savedAt: Date.now()
            };
            return localSet(values);
        });
    }

    function confirmWritten(settings, etag, expectedDocument) {
        return readRemote(settings).then(function(remote) {
            if(!remote.exists || !remote.etag || /^W\//i.test(remote.etag) || remote.etag !== etag) {
                throw new Error('The remote write could not be confirmed with the returned strong ETag; no baseline was saved. Inspect the remote file before retrying.');
            }
            return parseSyncDocument(remote.document).then(function(document) {
                if(document.revision !== expectedDocument.revision || document.updatedAt !== expectedDocument.updatedAt) {
                    throw new Error('The server returned a different document after writing; no baseline was saved. Inspect both copies before syncing again.');
                }
                return { remote: remote, document: document };
            });
        });
    }

    function buildState(context) {
        var localCredentials = getLocalCredentials();
        return fingerprint(localCredentials).then(function(localDigest) {
            return readRemote(context.settings).then(function(remote) {
                if(!remote.exists) {
                    return {
                        action: decideSync({ remoteExists: false, baselineEtag: context.meta.etag || '' }),
                        context: context,
                        localCredentials: localCredentials,
                        localFingerprint: localDigest,
                        remote: remote,
                        remoteDocument: null
                    };
                }
                if(!remote.etag || /^W\//i.test(remote.etag)) {
                    return {
                        action: 'missing-etag',
                        context: context,
                        localCredentials: localCredentials,
                        localFingerprint: localDigest,
                        remote: remote,
                        remoteDocument: null
                    };
                }
                return parseSyncDocument(remote.document).then(function(remoteDocument) {
                    var action = decideSync({
                        remoteExists: true,
                        remoteEtag: remote.etag,
                        baselineEtag: context.meta.etag || '',
                        localFingerprint: localDigest,
                        baselineFingerprint: context.meta.fingerprint || '',
                        remoteRevision: remoteDocument.revision,
                        baselineRemoteRevision: context.meta.remoteRevision || '',
                        remoteUpdatedAt: remoteDocument.updatedAt,
                        baselineRemoteUpdatedAt: context.meta.remoteUpdatedAt,
                        remoteDocumentHash: remote.contentHash,
                        baselineRemoteDocumentHash: context.meta.remoteDocumentHash || ''
                    });
                    return {
                        action: action,
                        context: context,
                        localCredentials: localCredentials,
                        localFingerprint: localDigest,
                        remote: remote,
                        remoteDocument: remoteDocument
                    };
                });
            });
        });
    }

    function createDocumentForState(state) {
        var previousUpdatedAt = state.remoteDocument ? state.remoteDocument.updatedAt : state.context.meta.remoteUpdatedAt;
        return createSyncDocument(state.localCredentials, previousUpdatedAt);
    }

    function pushState(state, label) {
        if(Object.keys(state.localCredentials).length === 0) {
            return Promise.reject(new Error('Automatic upload of an empty credential set is blocked. Use Push local explicitly if you intend to replace the remote file with an empty set.'));
        }
        return fingerprint(getLocalCredentials()).then(function(currentDigest) {
            if(currentDigest !== state.localFingerprint) throw new Error('Local credentials changed during sync. Nothing was uploaded; sync again.');
            return createDocumentForState(state).then(function(document) {
                return putRemote(state.context.settings, document, state.remote.etag).then(function(etag) {
                    return confirmWritten(state.context.settings, etag, document).then(function(confirmed) {
                        return setBaseline(etag, state.localCredentials, state.context.settings.endpoint, confirmed.document,
                            confirmed.remote.contentHash, state.context.settings.username)
                            .then(function() { return label || 'Uploaded this device’s changes to WebDAV.'; });
                    });
                });
            });
        });
    }

    function pullState(state, label) {
        var remoteCredentials = state.remoteDocument.credentials;
        if(Object.keys(remoteCredentials).length === 0) {
            return Promise.reject(new Error('Automatic download of an empty credential set is blocked. Use Pull remote explicitly if you intend to clear local credentials.'));
        }
        if(state.remoteDocument.revision === state.context.meta.remoteRevision) {
            return setBaseline(state.remote.etag, state.localCredentials, state.context.settings.endpoint, state.remoteDocument,
                state.remote.contentHash, state.context.settings.username)
                .then(function() { return 'The remote timestamp/ETag changed, but the credential revision is unchanged; baseline refreshed without replacing local data.'; });
        }
        return readRemote(state.context.settings).then(function(latestRemote) {
            if(!latestRemote.exists || latestRemote.etag !== state.remote.etag || latestRemote.contentHash !== state.remote.contentHash) {
                throw new Error('The remote file changed during sync. Nothing was replaced; sync again.');
            }
            return parseSyncDocument(latestRemote.document).then(function(latestDocument) {
                if(latestDocument.revision !== state.remoteDocument.revision) {
                    throw new Error('The remote revision changed during sync. Nothing was replaced; sync again.');
                }
                return fingerprint(getLocalCredentials()).then(function(currentDigest) {
                    if(currentDigest !== state.localFingerprint) throw new Error('Local credentials changed during sync. Nothing was replaced; sync again.');
                    return addBackup(label || 'Before automatic pull', state.localCredentials)
                        .then(function() { return credentialStorage.replaceAll(remoteCredentials); })
                        .then(function() { return setBaseline(state.remote.etag, remoteCredentials, state.context.settings.endpoint, state.remoteDocument,
                            latestRemote.contentHash, state.context.settings.username); })
                        .then(function() { return 'Downloaded the other device’s changes. Previous local data is available as a backup.'; });
                });
            });
        });
    }

    function messageForAction(action) {
        var messages = {
            'create': 'No common sync baseline exists. Automatic sync did not create a remote file; use Sync now or Push local to initialize deliberately.',
            'first-connect': 'This device has no common sync baseline. Choose Pull remote or Push local; automatic sync changed nothing.',
            'missing-etag': 'The WebDAV server did not provide a strong ETag. Automatic sync stopped to prevent unsafe writes.',
            'etag-inconsistent': 'The remote document changed without a matching strong ETag change. Automatic sync stopped; check the WebDAV server.',
            'remote-deleted': 'The remote file was deleted after the last sync. Automatic sync did not recreate it.',
            'conflict': 'Conflict: local credentials and the WebDAV file both changed since the shared baseline. Neither copy was overwritten; review both and choose Pull remote or Push local.',
            'unchanged': 'Automatic sync check: both devices match the last shared revision.',
            'disabled': 'Automatic WebDAV sync is disabled on this device.'
        };
        return messages[action] || 'Automatic sync stopped without changing data.';
    }

    function performAutomaticSync() {
        return getSettings().then(function(context) {
            if(context.settings.autoSyncIntervalMinutes <= 0) return { message: messageForAction('disabled'), isError: false };
            return buildState(context).then(function(state) {
                if(['create', 'first-connect', 'missing-etag', 'etag-inconsistent', 'remote-deleted', 'conflict', 'unchanged'].indexOf(state.action) !== -1) {
                    return { message: messageForAction(state.action), isError: ['missing-etag', 'etag-inconsistent', 'remote-deleted', 'conflict'].indexOf(state.action) !== -1 };
                }
                if(state.action === 'push') {
                    return pushState(state).then(function(message) { return { message: message, isError: false }; });
                }
                if(state.action === 'pull') {
                    return pullState(state).then(function(message) { return { message: message, isError: false }; });
                }
                return { message: messageForAction('first-connect'), isError: true };
            });
        }).catch(function(error) {
            return { message: error.message || 'Automatic WebDAV sync failed.', isError: true };
        });
    }

    function saveAutoStatus(message, isError) {
        var record = { message: message, isError: !!isError, updatedAt: Date.now() };
        setStatus(record.message, record.isError);
        var values = {};
        values[AUTO_STATUS_KEY] = record;
        return localSet(values).catch(function() {});
    }

    function runAutomaticSync(storage) {
        if(automaticRun) return automaticRun;
        if(storage) credentialStorage = storage;
        if(!credentialStorage) return Promise.reject(new Error('Credential storage is not initialized.'));
        automaticRun = performAutomaticSync().then(function(result) {
            return saveAutoStatus(result.message, result.isError);
        }).then(function() {
            automaticRun = null;
        }, function(error) {
            automaticRun = null;
            throw error;
        });
        return automaticRun;
    }

    function getAlarm(name) {
        return new Promise(function(resolve, reject) {
            try {
                var result = chrome.alarms.get(name, function(alarm) { resolve(alarm); });
                if(result && typeof result.then === 'function') result.then(resolve, reject);
            } catch(error) {
                reject(error);
            }
        });
    }

    function createAlarm(intervalMinutes) {
        return new Promise(function(resolve, reject) {
            try {
                var result = chrome.alarms.create(ALARM_NAME, {
                    delayInMinutes: intervalMinutes,
                    periodInMinutes: intervalMinutes
                });
                if(result && typeof result.then === 'function') result.then(resolve, reject);
                else resolve();
            } catch(error) {
                reject(error);
            }
        });
    }

    function clearAlarm() {
        return new Promise(function(resolve, reject) {
            try {
                var result = chrome.alarms.clear(ALARM_NAME, function() {
                    var error = chrome.runtime && chrome.runtime.lastError;
                    if(error) reject(new Error(error.message || String(error)));
                    else resolve();
                });
                if(result && typeof result.then === 'function') result.then(resolve, reject);
            } catch(error) {
                reject(error);
            }
        });
    }

    function configureAutoSyncAlarm(intervalMinutes) {
        var interval = Number(intervalMinutes);
        if(!Number.isInteger(interval) || interval < 0 || interval > 10080) {
            return Promise.reject(new Error('Choose an automatic sync interval from 0 to 10080 minutes.'));
        }
        if(!chrome.alarms) return Promise.reject(new Error('This browser does not provide the alarms API.'));
        if(interval === 0) return clearAlarm();
        return createAlarm(interval);
    }

    function ensureAutoSyncAlarm() {
        if(!chrome.alarms) return Promise.reject(new Error('This browser does not provide the alarms API.'));
        return localGet(SETTINGS_KEY).then(function(result) {
            var settings = result[SETTINGS_KEY] || {};
            var interval = typeof settings.autoSyncIntervalMinutes === 'undefined' ? 0 : Number(settings.autoSyncIntervalMinutes);
            if(!Number.isInteger(interval) || interval < 0 || interval > 10080) {
                return Promise.reject(new Error('The saved automatic sync interval is invalid. Review the WebDAV settings.'));
            }
            if(interval <= 0) return clearAlarm();
            return getAlarm(ALARM_NAME).then(function(alarm) {
                if(alarm && Number(alarm.periodInMinutes) === interval) return;
                return createAlarm(interval);
            });
        });
    }

    function initBackground(storage) {
        if(storage) credentialStorage = storage;
        if(backgroundInitialized) return ensureAutoSyncAlarm();
        backgroundInitialized = true;
        if(chrome.alarms && chrome.alarms.onAlarm) {
            chrome.alarms.onAlarm.addListener(function(alarm) {
                if(alarm && alarm.name === ALARM_NAME) runAutomaticSync(credentialStorage).catch(function() {});
            });
        }
        if(chrome.runtime.onStartup) chrome.runtime.onStartup.addListener(function() {
            ensureAutoSyncAlarm().catch(function() {});
        });
        if(chrome.runtime.onInstalled) chrome.runtime.onInstalled.addListener(function() {
            ensureAutoSyncAlarm().catch(function() {});
        });
        return ensureAutoSyncAlarm();
    }

    function syncNow() {
        return getSettings().then(function(context) {
            return buildState(context).then(function(state) {
                if(state.action === 'create') {
                    if(Object.keys(state.localCredentials).length === 0) {
                        throw new Error('The first sync will not create an empty remote file. Add credentials or use the explicit Push local action.');
                    }
                    return createDocumentForState(state).then(function(document) {
                        return putRemote(context.settings, document, '').then(function(etag) {
                            return confirmWritten(context.settings, etag, document).then(function(confirmed) {
                                return setBaseline(etag, state.localCredentials, context.settings.endpoint, confirmed.document,
                                    confirmed.remote.contentHash, context.settings.username)
                                    .then(function() { setStatus('Created the plaintext WebDAV file using If-None-Match. This device now has a sync baseline.'); });
                            });
                        });
                    });
                }
                if(state.action === 'first-connect') {
                    setStatus(messageForAction('first-connect'), true);
                    return;
                }
                if(state.action === 'conflict' || state.action === 'remote-deleted' || state.action === 'missing-etag' || state.action === 'etag-inconsistent') {
                    setStatus(messageForAction(state.action), true);
                    return;
                }
                if(state.action === 'unchanged') {
                    setStatus(messageForAction('unchanged'));
                    return;
                }
                if(state.action === 'push') return pushState(state).then(setStatus);
                if(state.action === 'pull') return pullState(state).then(setStatus);
                setStatus(messageForAction(state.action), true);
            });
        }).catch(function(error) {
            setStatus(error.message || 'WebDAV synchronization failed.', true);
        });
    }

    function pullRemote() {
        return getSettings().then(function(context) {
            var localBefore = getLocalCredentials();
            return fingerprint(localBefore).then(function(localDigest) {
                return readRemote(context.settings).then(function(remote) {
                    if(!remote.exists) throw new Error('There is no remote file to download.');
                    if(!remote.etag || /^W\//i.test(remote.etag)) throw new Error('The WebDAV server must return a strong ETag before pulling.');
                    return parseSyncDocument(remote.document).then(function(remoteDocument) {
                        var count = Object.keys(remoteDocument.credentials).length;
                        if(!window.confirm('Replace this device’s credentials with ' + count + ' entries from the plaintext WebDAV file? A local backup will be kept.')) return;
                        return readRemote(context.settings).then(function(latestRemote) {
                            if(!latestRemote.exists || latestRemote.etag !== remote.etag || latestRemote.contentHash !== remote.contentHash) throw new Error('The remote file changed while you were confirming. Nothing was replaced; review it and retry.');
                            return fingerprint(getLocalCredentials()).then(function(currentDigest) {
                                if(currentDigest !== localDigest) throw new Error('Local credentials changed while you were confirming. Nothing was replaced; review and retry.');
                                return addBackup('Before manual pull', localBefore)
                                    .then(function() { return credentialStorage.replaceAll(remoteDocument.credentials); })
                                    .then(function() { return setBaseline(remote.etag, remoteDocument.credentials, context.settings.endpoint, remoteDocument,
                                        latestRemote.contentHash, context.settings.username); })
                                    .then(function() { setStatus('Downloaded the plaintext WebDAV file. Previous local data is available as a backup.'); });
                            });
                        });
                    });
                });
            });
        }).catch(function(error) { setStatus(error.message || 'Download failed.', true); });
    }

    function pushLocal() {
        return getSettings().then(function(context) {
            var localCredentials = getLocalCredentials();
            return fingerprint(localCredentials).then(function(localDigest) {
                return readRemote(context.settings).then(function(remote) {
                    if(remote.exists && (!remote.etag || /^W\//i.test(remote.etag))) {
                        throw new Error('The WebDAV server must return a strong ETag. The existing remote file will not be overwritten.');
                    }
                    var count = Object.keys(localCredentials).length;
                    var promptText = remote.exists ?
                        'Replace the current WebDAV file with this device’s ' + count + ' entries? The previous remote file will be saved as a local backup. The server stores the new file as plaintext.' :
                        'Create a new plaintext WebDAV file with this device’s ' + count + ' entries?';
                    if(!window.confirm(promptText)) return;
                    var backup = remote.exists ? addRemoteBackup('Before manual push', remote.document) : Promise.resolve();
                    return backup.then(function() {
                        return fingerprint(getLocalCredentials()).then(function(currentDigest) {
                            if(currentDigest !== localDigest) throw new Error('Local credentials changed while you were confirming. Nothing was uploaded; review and retry.');
                            var previousTimestamp = remote.document && Number.isSafeInteger(remote.document.updatedAt) ? remote.document.updatedAt : 0;
                            return createSyncDocument(localCredentials, previousTimestamp).then(function(document) {
                                return putRemote(context.settings, document, remote.exists ? remote.etag : '').then(function(etag) {
                                    return confirmWritten(context.settings, etag, document).then(function(confirmed) {
                                        return setBaseline(etag, localCredentials, context.settings.endpoint, confirmed.document,
                                            confirmed.remote.contentHash, context.settings.username);
                                    });
                                });
                            }).then(function() { setStatus('Uploaded this device’s credentials. The WebDAV server stores the file as plaintext.'); });
                        });
                    });
                });
            });
        }).catch(function(error) { setStatus(error.message || 'Upload failed.', true); });
    }

    function updateBackupButton() {
        localGet(BACKUPS_KEY).then(function(result) {
            var backups = result[BACKUPS_KEY];
            backupAvailable = Array.isArray(backups) && backups.length > 0;
            if(backupButton) backupButton.disabled = operationInProgress || !backupAvailable;
        }).catch(function() {
            backupAvailable = false;
            if(backupButton) backupButton.disabled = true;
        });
    }

    function downloadBackup() {
        return localGet(BACKUPS_KEY).then(function(result) {
            var backups = result[BACKUPS_KEY];
            if(!Array.isArray(backups) || backups.length === 0) return;
            var backup = backups[0];
            var content = Object.prototype.hasOwnProperty.call(backup, 'remoteDocument') ? backup.remoteDocument : backup.credentials;
            var blob = new Blob([JSON.stringify(content, null, 2)], { type: 'application/json' });
            var link = document.createElement('a');
            link.href = URL.createObjectURL(blob);
            link.download = 'multipass-local-backup.json';
            link.click();
            setTimeout(function() { URL.revokeObjectURL(link.href); }, 1000);
            setStatus('Downloaded the latest local backup. Treat this file as sensitive; it may contain plaintext credentials.');
        }).catch(function(error) { setStatus(error.message || 'Could not download the backup.', true); });
    }

    function saveSettings() {
        var endpoint = validateEndpoint(document.getElementById('webdav-url').value.trim());
        var interval = Number(intervalSelect.value);
        if(!Number.isInteger(interval) || interval < 0 || interval > 10080) throw new Error('Choose an automatic sync interval from 0 to 10080 minutes.');
        var settings = {
            endpoint: endpoint,
            username: document.getElementById('webdav-username').value,
            password: document.getElementById('webdav-password').value,
            autoSyncIntervalMinutes: interval
        };
        return localGet([SETTINGS_KEY, META_KEY]).then(function(result) {
            var oldSettings = result[SETTINGS_KEY] || {};
            var meta = result[META_KEY] || {};
            if(oldSettings.endpoint !== endpoint || (oldSettings.username || '') !== settings.username) meta = {};
            var values = {};
            values[SETTINGS_KEY] = settings;
            values[META_KEY] = meta;
            return localSet(values).then(function() {
                return configureAutoSyncAlarm(interval);
            }).then(function() {
                setStatus(interval ? 'WebDAV settings and automatic sync interval saved on this device. Credentials stay local; the remote file is plaintext.' : 'WebDAV settings saved on this device. Automatic sync is off.');
                return settings;
            });
        });
    }

    function init(storage) {
        credentialStorage = storage;
        statusElement = document.getElementById('webdav-status');
        pullButton = document.getElementById('webdav-pull');
        pushButton = document.getElementById('webdav-push');
        backupButton = document.getElementById('webdav-backup');
        saveButton = document.getElementById('webdav-save');
        syncButton = document.getElementById('webdav-sync');
        intervalSelect = document.getElementById('webdav-interval');

        localGet([SETTINGS_KEY, AUTO_STATUS_KEY]).then(function(result) {
            var settings = result[SETTINGS_KEY] || {};
            document.getElementById('webdav-url').value = settings.endpoint || '';
            document.getElementById('webdav-username').value = settings.username || '';
            document.getElementById('webdav-password').value = settings.password || '';
            intervalSelect.value = String(Number(settings.autoSyncIntervalMinutes) || 0);
            var autoStatus = result[AUTO_STATUS_KEY];
            if(autoStatus && autoStatus.message) setStatus(autoStatus.message, autoStatus.isError);
        }).catch(function() { setStatus('Could not load saved WebDAV settings.', true); });

        if(chrome.storage.onChanged) {
            chrome.storage.onChanged.addListener(function(changes, namespace) {
                if(namespace === 'local' && changes[AUTO_STATUS_KEY] && changes[AUTO_STATUS_KEY].newValue) {
                    var record = changes[AUTO_STATUS_KEY].newValue;
                    setStatus(record.message, record.isError);
                }
            });
        }

        saveButton.addEventListener('click', function() {
            runExclusive(saveSettings);
        });
        syncButton.addEventListener('click', function() {
            runExclusive(function() { return saveSettings().then(syncNow); });
        });
        pullButton.addEventListener('click', function() {
            runExclusive(function() { return saveSettings().then(pullRemote); });
        });
        pushButton.addEventListener('click', function() {
            runExclusive(function() { return saveSettings().then(pushLocal); });
        });
        backupButton.addEventListener('click', function() { runExclusive(downloadBackup); });
        updateBackupButton();
    }

    return {
        init: init,
        initBackground: initBackground,
        validateEndpoint: validateEndpoint,
        decideSync: decideSync,
        readRemote: readRemote,
        putRemote: putRemote,
        createSyncDocument: createSyncDocument,
        parseSyncDocument: parseSyncDocument,
        stableCredentials: stableCredentials,
        fingerprint: fingerprint,
        runAutomaticSync: runAutomaticSync,
        configureAutoSyncAlarm: configureAutoSyncAlarm,
        ensureAutoSyncAlarm: ensureAutoSyncAlarm,
        format: SYNC_FORMAT
    };
}();

module.exports = WebDAVSync;
