'use strict';

var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var http = require('http');
var net = require('net');
var childProcess = require('child_process');
var Sync = require('../js/webdav_sync');

function freePort() {
    return new Promise(function(resolve, reject) {
        var server = net.createServer();
        server.listen(0, '127.0.0.1', function() {
            var port = server.address().port;
            server.close(function(error) { if(error) reject(error); else resolve(port); });
        });
        server.on('error', reject);
    });
}

function waitForServer(endpoint, child) {
    var started = Date.now();
    return new Promise(function(resolve, reject) {
        function probe() {
            if(child.exitCode !== null) return reject(new Error('WsgiDAV exited before becoming ready. Install requirements-webdav-e2e.txt.'));
            http.get(endpoint, function(response) {
                response.resume();
                if(response.statusCode < 500) return resolve();
                retry();
            }).on('error', retry);
        }
        function retry() {
            if(Date.now() - started > 10000) return reject(new Error('Timed out waiting for local WsgiDAV.'));
            setTimeout(probe, 150);
        }
        probe();
    });
}

function createStorageMock() {
    var values = Object.create(null);
    return {
        values: values,
        api: {
            runtime: { lastError: null },
            storage: {
                local: {
                    get: function(keys, callback) {
                        var result = {};
                        (Array.isArray(keys) ? keys : [keys]).forEach(function(key) {
                            if(Object.prototype.hasOwnProperty.call(values, key)) result[key] = values[key];
                        });
                        callback(result);
                    },
                    set: function(changes, callback) {
                        Object.keys(changes).forEach(function(key) { values[key] = changes[key]; });
                        callback();
                    }
                },
                onChanged: { addListener: function() {} }
            }
        }
    };
}

async function storeBaseline(values, endpoint, username, credentials, remote, parsedRemote) {
    values.multipassWebdavSyncMeta = {
        endpoint: endpoint,
        authUsername: username || '',
        etag: remote.etag,
        fingerprint: await Sync.fingerprint(credentials),
        remoteRevision: parsedRemote.revision,
        remoteUpdatedAt: parsedRemote.updatedAt,
        remoteDocumentHash: remote.contentHash,
        savedAt: Date.now()
    };
}

async function main() {
    if(!globalThis.crypto) globalThis.crypto = require('crypto').webcrypto;
    var originalChrome = global.chrome;
    var port = await freePort();
    var root = fs.mkdtempSync(path.join(os.tmpdir(), 'multipass-wsgidav-'));
    var python = process.env.PYTHON || 'python3';
    var serverScript = path.join(__dirname, 'webdav_server.py');
    var child = childProcess.spawn(python, [serverScript, '--no-config', '--host', '127.0.0.1', '--port', String(port), '--root', root, '--auth', 'anonymous', '-q'], {
        stdio: 'ignore',
        env: process.env
    });
    var endpoint = 'http://127.0.0.1:' + port + '/multipass-sync.json';
    var settings = { endpoint: Sync.validateEndpoint(endpoint), username: '', password: '' };

    try {
        await waitForServer(endpoint, child);
        var storageMock = createStorageMock();
        global.chrome = storageMock.api;
        storageMock.values.multipassWebdavSettings = {
            endpoint: endpoint,
            username: '',
            password: '',
            autoSyncIntervalMinutes: 5
        };

        var local = {
            'https://fixture.invalid/': {
                url: 'https://fixture.invalid/', username: 'e2e-user', password: 'fixture-only-password', priority: '1'
            }
        };
        var credentialStorage = {
            asJSON: function() { return JSON.stringify(local); },
            replaceAll: function(credentials) {
                local = JSON.parse(JSON.stringify(Sync.stableCredentials(credentials)));
                return Promise.resolve();
            }
        };

        var missing = await Sync.readRemote(settings);
        assert.strictEqual(missing.exists, false, 'the fresh DAV share should not contain the sync file');
        await Sync.runAutomaticSync(credentialStorage);
        assert.match(storageMock.values.multipassWebdavAutoStatus.message, /did not create a remote file/);
        assert.strictEqual((await Sync.readRemote(settings)).exists, false, 'auto sync must not initialize a remote file');

        var initialDocument = await Sync.createSyncDocument(local);
        var createdEtag = await Sync.putRemote(settings, initialDocument, '');
        assert(createdEtag && !/^W\//i.test(createdEtag), 'WsgiDAV must return a strong ETag for a successful create');
        var firstConnect = await Sync.readRemote(settings);
        assert.strictEqual(firstConnect.exists, true);
        assert.strictEqual(firstConnect.etag, createdEtag);
        assert(JSON.stringify(firstConnect.document).includes('fixture-only-password'), 'remote JSON intentionally contains plaintext credentials');
        await Sync.runAutomaticSync(credentialStorage);
        assert.match(storageMock.values.multipassWebdavAutoStatus.message, /no common sync baseline/);
        assert.strictEqual((await Sync.readRemote(settings)).etag, createdEtag, 'first connect must not overwrite the remote file');

        var duplicateCreateRejected = false;
        try {
            await Sync.putRemote(settings, initialDocument, '');
        } catch(error) {
            duplicateCreateRejected = /server rejected the conditional write/.test(error.message);
        }
        assert.strictEqual(duplicateCreateRejected, true, 'If-None-Match must prevent a duplicate first-create overwrite');

        var parsedInitial = await Sync.parseSyncDocument(firstConnect.document);
        await storeBaseline(storageMock.values, endpoint, '', local, firstConnect, parsedInitial);
        await Sync.runAutomaticSync(credentialStorage);
        assert.match(storageMock.values.multipassWebdavAutoStatus.message, /match the last shared revision/);

        var localOnly = {
            'https://fixture.invalid/': {
                url: 'https://fixture.invalid/', username: 'e2e-user-local', password: 'fixture-local-change', priority: '2'
            }
        };
        local = localOnly;
        await Sync.runAutomaticSync(credentialStorage);
        var afterLocalPush = await Sync.readRemote(settings);
        var parsedAfterLocalPush = await Sync.parseSyncDocument(afterLocalPush.document);
        assert.deepStrictEqual(JSON.parse(JSON.stringify(parsedAfterLocalPush.credentials)), localOnly, 'a local-only change should upload');
        assert.match(storageMock.values.multipassWebdavAutoStatus.message, /Uploaded this device/);

        var remoteOnly = {
            'https://fixture.invalid/': {
                url: 'https://fixture.invalid/', username: 'e2e-user-remote', password: 'fixture-remote-change', priority: '3'
            }
        };
        var remoteDocument = await Sync.createSyncDocument(remoteOnly, parsedAfterLocalPush.updatedAt);
        var remoteOnlyEtag = await Sync.putRemote(settings, remoteDocument, afterLocalPush.etag);
        assert(remoteOnlyEtag && !/^W\//i.test(remoteOnlyEtag));
        await Sync.runAutomaticSync(credentialStorage);
        assert.deepStrictEqual(JSON.parse(JSON.stringify(local)), remoteOnly, 'a remote-only change should download');
        assert.match(storageMock.values.multipassWebdavAutoStatus.message, /Downloaded the other device/);

        var baselineRemote = await Sync.readRemote(settings);
        var baselineDocument = await Sync.parseSyncDocument(baselineRemote.document);
        await storeBaseline(storageMock.values, endpoint, '', local, baselineRemote, baselineDocument);
        var localConflict = {
            'https://fixture.invalid/': {
                url: 'https://fixture.invalid/', username: 'local-conflict', password: 'local-conflict-secret', priority: '4'
            }
        };
        local = localConflict;
        var remoteConflict = {
            'https://fixture.invalid/': {
                url: 'https://fixture.invalid/', username: 'remote-conflict', password: 'remote-conflict-secret', priority: '5'
            }
        };
        var remoteConflictDoc = await Sync.createSyncDocument(remoteConflict, baselineDocument.updatedAt);
        var remoteConflictEtag = await Sync.putRemote(settings, remoteConflictDoc, baselineRemote.etag);
        var metaBeforeConflict = JSON.stringify(storageMock.values.multipassWebdavSyncMeta);
        await Sync.runAutomaticSync(credentialStorage);
        assert.match(storageMock.values.multipassWebdavAutoStatus.message, /Conflict/);
        assert.deepStrictEqual(JSON.parse(JSON.stringify(local)), localConflict, 'conflict must preserve local credentials');
        var remoteAfterConflict = await Sync.readRemote(settings);
        assert.strictEqual(remoteAfterConflict.etag, remoteConflictEtag, 'conflict must not write to the remote file');
        assert.strictEqual(JSON.stringify(storageMock.values.multipassWebdavSyncMeta), metaBeforeConflict, 'conflict must not advance the baseline');

        var parsedRemoteConflict = await Sync.parseSyncDocument(remoteAfterConflict.document);
        await storeBaseline(storageMock.values, endpoint, '', remoteConflict, remoteAfterConflict, parsedRemoteConflict);
        local = {};
        await Sync.runAutomaticSync(credentialStorage);
        assert.match(storageMock.values.multipassWebdavAutoStatus.message, /empty credential set is blocked/);
        assert.strictEqual((await Sync.readRemote(settings)).etag, remoteConflictEtag, 'empty local state must not auto-delete the remote file');

        local = remoteConflict;
        await storeBaseline(storageMock.values, endpoint, '', local, remoteAfterConflict, parsedRemoteConflict);
        var emptyDocument = await Sync.createSyncDocument({}, parsedRemoteConflict.updatedAt);
        await Sync.putRemote(settings, emptyDocument, remoteAfterConflict.etag);
        await Sync.runAutomaticSync(credentialStorage);
        assert.match(storageMock.values.multipassWebdavAutoStatus.message, /empty credential set is blocked/);
        assert.deepStrictEqual(JSON.parse(JSON.stringify(local)), remoteConflict, 'empty remote snapshot must not auto-clear local data');

        // Restore an explicit baseline and then delete the server file; auto sync must never recreate it.
        var emptyRemote = await Sync.readRemote(settings);
        var parsedEmpty = await Sync.parseSyncDocument(emptyRemote.document);
        await storeBaseline(storageMock.values, endpoint, '', {}, emptyRemote, parsedEmpty);
        var deleteResponse = await fetch(endpoint, { method: 'DELETE' });
        assert(deleteResponse.status === 200 || deleteResponse.status === 204);
        await Sync.runAutomaticSync(credentialStorage);
        assert.match(storageMock.values.multipassWebdavAutoStatus.message, /was deleted/);
        assert.strictEqual((await Sync.readRemote(settings)).exists, false, 'automatic sync must not recreate a deleted file');

        console.log('Local WsgiDAV E2E passed: plaintext JSON, conditional create/update, first-connect stop, single-side upload/download, conflict stop, empty-snapshot safeguards, and remote-delete stop.');
    } finally {
        global.chrome = originalChrome;
        child.kill('SIGTERM');
        fs.rmSync(root, { recursive: true, force: true });
    }
}

main().catch(function(error) {
    console.error(error.stack || error);
    process.exitCode = 1;
});
