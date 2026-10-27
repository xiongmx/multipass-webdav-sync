'use strict';
require('./helpers/web_locks').installGlobalWebLocks();

var assert = require('assert');
var childProcess = require('child_process');
var fs = require('fs');
var path = require('path');
var vm = require('vm');
var webcrypto = require('crypto').webcrypto;

var root = path.resolve(__dirname, '..');
var packages = [
    'dist/chrome-multipass-1.1.2.zip',
    'dist/firefox-multipass-1.1.2.xpi',
    'dist/opera-multipass-1.1.2.zip',
    'dist/firefox-android-multipass-1.1.2.xpi'
];
var CONFIG_KEY = 'vaultConfig';
var VALUES_KEY = 'vaultEncryptedValues';
var SESSION_KEY = 'vaultRootMaterial';
var PASSPHRASE = 'dummyphrase-for-package-test';

function unzipText(packagePath, member) {
    return childProcess.execFileSync('unzip', ['-p', packagePath, member], {
        cwd: root,
        encoding: 'utf8'
    });
}

function packageFiles(packagePath) {
    var names = childProcess.execFileSync('unzip', ['-Z1', packagePath], {
        cwd: root,
        encoding: 'utf8'
    }).trim().split(/\r?\n/);
    ['manifest.json', 'options.html', 'popin.html', 'js/extension.js', 'js/option.js', 'js/popin.js'].forEach(function(name) {
        assert.ok(names.indexOf(name) !== -1, packagePath + ' must contain ' + name);
    });
}

function assertManifestPolicy(packagePath) {
    var manifest = JSON.parse(unzipText(packagePath, 'manifest.json'));
    assert.strictEqual(manifest.version, '1.1.2', packagePath + ' manifest version');
    assert.strictEqual(manifest.short_name, 'MP WebDAV', packagePath + ' manifest short_name');
    assert.strictEqual(manifest.name, '__MSG_extName__', packagePath + ' manifest name');
    assert.strictEqual(manifest.description, '__MSG_extDescription__', packagePath + ' manifest description');
    assert((manifest.permissions || []).includes('alarms'), packagePath + ' must declare alarms for periodic sync');
    if (Object.prototype.hasOwnProperty.call(manifest, 'host_permissions')) {
        assert.deepStrictEqual(manifest.host_permissions, ['https://*/*'], packagePath + ' host_permissions');
    }
    if (manifest.manifest_version === 2) {
        var urlPermissions = (manifest.permissions || []).filter(function(permission) {
            return /^https?:\/\//i.test(permission) || permission === '<all_urls>';
        });
        assert.deepStrictEqual(urlPermissions, ['https://*/*'], packagePath + ' MV2 URL permissions');
    }
    ['host_permissions', 'permissions'].forEach(function(field) {
        (manifest[field] || []).forEach(function(permission) {
            assert.notStrictEqual(permission, '<all_urls>', packagePath + ' must not request <all_urls>');
            assert.strictEqual(/^http:\/\//i.test(permission), false, packagePath + ' must not request HTTP URL patterns');
        });
    });
}

function assertHtmlPolicy(packagePath, member) {
    var html = unzipText(packagePath, member);
    var input = html.match(/<input\b[^>]*\bid=["']url["'][^>]*>/i);
    assert.ok(input, packagePath + ' ' + member + ' must have an id=url input');
    assert.ok(/\bvalue=["']\^https:\/\/["']/i.test(input[0]), packagePath + ' ' + member + ' id=url must have value=^https://');
    assert.ok(/HTTPS/i.test(html), packagePath + ' ' + member + ' must mention HTTPS');
    assert.ok(/[仅只必须].{0,12}HTTPS|HTTPS.{0,12}[仅只必须]/i.test(html), packagePath + ' ' + member + ' must contain an explicit Chinese HTTPS-only notice');
}

function hashKey(value) {
    var result = 0;
    for (var index = 0; index < value.length; index += 1) result = ((result << 5) - result + value.charCodeAt(index)) | 0;
    return String(result);
}

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function makeChrome(shared, manifestVersion) {
    function emit(area, changes) {
        shared.changeListeners.slice().forEach(function(listener) { listener(changes, area); });
    }
    function store(area) {
        var data = shared[area];
        return {
            get: function(keys, callback) {
                var result = {}, names;
                if (typeof keys === 'string') names = [keys];
                else if (Array.isArray(keys)) names = keys;
                else if (keys && typeof keys === 'object') names = Object.keys(keys);
                else names = Object.keys(data);
                names.forEach(function(key) {
                    if (Object.prototype.hasOwnProperty.call(data, key)) result[key] = data[key];
                });
                callback(result);
            },
            set: function(update, callback) {
                var changes = {};
                Object.keys(update).forEach(function(key) {
                    changes[key] = { oldValue: data[key], newValue: update[key] };
                    data[key] = update[key];
                });
                emit(area, changes);
                if (callback) callback();
            },
            remove: function(keys, callback) {
                var changes = {}, names = Array.isArray(keys) ? keys : [keys];
                names.forEach(function(key) {
                    if (Object.prototype.hasOwnProperty.call(data, key)) {
                        changes[key] = { oldValue: data[key] };
                        delete data[key];
                    }
                });
                emit(area, changes);
                if (callback) callback();
            },
            setAccessLevel: function() { return Promise.resolve(); }
        };
    }
    var listeners = { auth: [], completed: [], alarms: [] };
    return {
        runtime: {
            lastError: null,
            getManifest: function() { return { manifest_version: manifestVersion }; },
            onStartup: { addListener: function() {} },
            onInstalled: { addListener: function() {} }
        },
        action: { setBadgeText: function() {}, setBadgeBackgroundColor: function() {} },
        browserAction: { setBadgeText: function() {}, setBadgeBackgroundColor: function() {} },
        storage: {
            local: store('local'),
            session: store('session'),
            onChanged: { addListener: function(callback) { shared.changeListeners.push(callback); } }
        },
        alarms: { clear: function(name, callback) { if (callback) callback(true); }, create: function() {}, onAlarm: { addListener: function(callback) { listeners.alarms.push(callback); } } },
        webRequest: {
            onAuthRequired: { addListener: function(callback, filter, extraInfoSpec) {
                listeners.auth.push({ callback: callback, filter: filter, extraInfoSpec: extraInfoSpec });
            } },
            onCompleted: { addListener: function(callback, filter) { listeners.completed.push({ callback: callback, filter: filter }); }
            }
        },
        tabs: {
            onUpdated: { addListener: function() {} },
            onActivated: { addListener: function() {} },
            get: function(tabId, callback) { callback({ id: tabId, url: 'https://example.test/' }); }
        },
        __state: listeners
    };
}

function jsonValue(value) { return JSON.parse(JSON.stringify(value)); }
function tick() { return new Promise(function(resolve) { setImmediate(resolve); }); }
async function settle() { await tick(); await tick(); await tick(); }

var records = [
    { url: '^https://', username: 'dummy-user', password: 'dummy-site-password', priority: 1 },
    { url: '.*', username: 'broad-user', password: 'broad-site-password', priority: 2 },
    { url: '^http://', username: 'old-http-user', password: 'old-http-password', priority: 3 }
];

async function createEncryptedFixture() {
    var shared = { local: {}, session: {}, changeListeners: [] };
    var oldChrome = global.chrome;
    var vaultPath = require.resolve('../js/vault');
    try {
        global.chrome = makeChrome(shared, 3);
        if(!global.crypto) Object.defineProperty(global, 'crypto', { value: webcrypto, configurable: true });
        if(!global.TextEncoder) Object.defineProperty(global, 'TextEncoder', { value: TextEncoder, configurable: true });
        if(!global.TextDecoder) Object.defineProperty(global, 'TextDecoder', { value: TextDecoder, configurable: true });
        global.btoa = global.btoa || function(value) { return Buffer.from(value, 'binary').toString('base64'); };
        global.atob = global.atob || function(value) { return Buffer.from(value, 'base64').toString('binary'); };
        delete require.cache[vaultPath];
        var Vault = require('../js/vault');
        await Vault.ready();
        await Vault.create(PASSPHRASE);
        var credentials = {};
        records.forEach(function(record) { credentials[hashKey(record.url)] = record; });
        await Vault.setAsync('credentials', credentials);
        assert.strictEqual(Vault.isUnlocked(), true);
        assert.ok(shared.local[CONFIG_KEY] && shared.local.credentials.format === 'multipass-vault-v1');
        assert.ok(shared.session[SESSION_KEY]);
        var localJson = JSON.stringify(shared.local);
        assert.strictEqual(localJson.indexOf(PASSPHRASE), -1, 'local JSON must not contain the dummy passphrase');
        assert.strictEqual(localJson.indexOf('dummy-site-password'), -1, 'local JSON must not contain site passwords');
        assert.strictEqual(localJson.indexOf('broad-site-password'), -1, 'local JSON must not contain broad passwords');
        assert.strictEqual(localJson.indexOf('old-http-password'), -1, 'local JSON must not contain old HTTP passwords');
        assert.strictEqual(localJson.indexOf(SESSION_KEY), -1, 'root material must not be in local storage');
        assert.strictEqual(JSON.stringify(shared.session).indexOf(PASSPHRASE), -1, 'session must not contain the passphrase');
        return { local: clone(shared.local), session: clone(shared.session) };
    } finally {
        delete require.cache[vaultPath];
        global.chrome = oldChrome;
    }
}

async function executeBundle(packagePath, manifest, fixture) {
    var shared = { local: clone(fixture.local), session: clone(fixture.session), changeListeners: [] };
    var chrome = makeChrome(shared, manifest.manifest_version);
    var fetchCalls = 0;
    var context = {
        chrome: chrome, URL: URL, TextEncoder: TextEncoder, TextDecoder: TextDecoder,
        Uint8Array: Uint8Array, Promise: Promise, JSON: JSON, Number: Number, Object: Object,
        Array: Array, String: String, RegExp: RegExp, Date: Date, Math: Math, console: console,
        crypto: webcrypto, navigator: { locks: global.navigator.locks },
        fetch: function() { fetchCalls += 1; return Promise.reject(new Error('network is forbidden in package HTTPS test')); },
        btoa: function(value) { return Buffer.from(value, 'binary').toString('base64'); },
        atob: function(value) { return Buffer.from(value, 'base64').toString('binary'); },
        setTimeout: setTimeout, clearTimeout, setImmediate: setImmediate
    };
    context.globalThis = context;
    vm.runInNewContext(unzipText(packagePath, 'js/extension.js'), context, { filename: packagePath + ':js/extension.js' });
    await settle();
    assert.strictEqual(chrome.__state.auth.length, 1, packagePath + ' must register one auth listener');
    assert.strictEqual(chrome.__state.alarms.length, 1, packagePath + ' must register its periodic-sync alarm listener');
    assert.deepStrictEqual(jsonValue(chrome.__state.auth[0].filter), { urls: ['https://*/*'] }, packagePath + ' auth filter');
    assert.deepStrictEqual(jsonValue(chrome.__state.completed[0].filter), { urls: ['https://*/*'] }, packagePath + ' completed filter');
    assert.deepStrictEqual(jsonValue(chrome.__state.auth[0].extraInfoSpec), [manifest.manifest_version >= 3 ? 'asyncBlocking' : 'blocking']);
    function auth(status) {
        var listener = chrome.__state.auth[0].callback;
        return manifest.manifest_version >= 3 ? new Promise(function(resolve) { listener(status, resolve); }) : Promise.resolve(listener(status));
    }
    var base = { tabId: 7, requestId: 'request-' };
    for(var url of ['http://remote.test/file', 'http://localhost:8080/file', 'http://127.0.0.1/file', 'http://[::1]/file']) {
        assert.deepStrictEqual(jsonValue(await auth(Object.assign({}, base, { url: url, scheme: 'basic', isProxy: false }))), {}, packagePath + ' must reject ' + url);
    }
    for(var status of [
        { url: 'https://remote.test/file', scheme: 'basic', isProxy: true },
        { url: 'https://remote.test/file', scheme: 'digest', isProxy: false },
        { url: 'https://remote.test/file', isProxy: false },
        { url: 'https://remote.test/file', scheme: 'basic' },
        { scheme: 'basic', isProxy: false }
    ]) {
        assert.deepStrictEqual(jsonValue(await auth(Object.assign({}, base, status))), {}, packagePath + ' must fail closed for invalid challenge');
    }
    assert.deepStrictEqual(jsonValue(await auth(Object.assign({}, base, { url: 'https://remote.test/file', scheme: 'basic', isProxy: false }))), {
        authCredentials: { username: 'dummy-user', password: 'dummy-site-password' }
    }, packagePath + ' HTTPS Basic must return decrypted fixture credentials');

    await chrome.storage.session.remove(SESSION_KEY, function() {});
    await settle();
    assert.deepStrictEqual(jsonValue(await auth(Object.assign({}, base, { url: 'https://remote.test/file', scheme: 'basic', isProxy: false }))), {}, packagePath + ' must reject HTTPS after session root removal');
    assert.strictEqual(fetchCalls, 0, packagePath + ' auth path must not fetch after lock');

    var freshChrome = makeChrome(shared, manifest.manifest_version);
    var freshContext = Object.assign({}, context, { chrome: freshChrome });
    freshContext.globalThis = freshContext;
    vm.runInNewContext(unzipText(packagePath, 'js/extension.js'), freshContext, { filename: packagePath + ':fresh:js/extension.js' });
    await settle();
    assert.strictEqual(freshChrome.__state.auth.length, 1);
    var freshStatus = Object.assign({}, base, { url: 'https://remote.test/file', scheme: 'basic', isProxy: false });
    var freshResponse = manifest.manifest_version >= 3 ? await new Promise(function(resolve) { freshChrome.__state.auth[0].callback(freshStatus, resolve); }) : await freshChrome.__state.auth[0].callback(freshStatus);
    assert.deepStrictEqual(jsonValue(freshResponse), {}, packagePath + ' fresh VM with empty session must start locked');
}

async function main() {
    var fixture = await createEncryptedFixture();
    for (var packageIndex = 0; packageIndex < packages.length; packageIndex += 1) {
        var relativePath = packages[packageIndex];
        var packagePath = path.join(root, relativePath);
        assert.ok(fs.existsSync(packagePath), 'missing package: ' + packagePath);
        packageFiles(packagePath);
        assertManifestPolicy(packagePath);
        assertHtmlPolicy(packagePath, 'options.html');
        assertHtmlPolicy(packagePath, 'popin.html');
        ['js/extension.js', 'js/option.js', 'js/popin.js'].forEach(function(member) {
            var source = unzipText(packagePath, member);
            assert.strictEqual(source.indexOf('<all_urls>'), -1, packagePath + ' ' + member + ' contains <all_urls>');
            assert.strictEqual(source.indexOf('http://*/*'), -1, packagePath + ' ' + member + ' contains HTTP wildcard listener');
        });
        var extensionSource = unzipText(packagePath, 'js/extension.js');
        assert.ok(extensionSource.indexOf('multipass-vault-v1') !== -1, packagePath + ' must include the vault format marker');
        assert.ok(extensionSource.indexOf('vaultEncryptedValues') !== -1, packagePath + ' must include encrypted vault storage code');
        assert.ok(extensionSource.indexOf('multipass-webdav-plain-v1') !== -1, packagePath + ' must include WebDAV code');
        assert.ok(extensionSource.indexOf('credentials:"omit"') !== -1 || extensionSource.indexOf("credentials:'omit'") !== -1 || extensionSource.indexOf('credentials="omit"') !== -1, packagePath + ' WebDAV fetch must use omitted credentials');
        var manifest = JSON.parse(unzipText(packagePath, 'manifest.json'));
        await executeBundle(packagePath, manifest, fixture);
    }
    console.log('Packaged HTTPS policy, Vault authentication, and WebDAV marker tests passed.');
}

main().catch(function(error) {
    console.error(error.stack || error);
    process.exitCode = 1;
});
