'use strict';

var assert = require('assert');
var fs = require('fs');
var path = require('path');
var root = path.resolve(__dirname, '..');
var english = JSON.parse(fs.readFileSync(path.join(root, '_locales/en/messages.json'), 'utf8'));
var chinese = JSON.parse(fs.readFileSync(path.join(root, '_locales/zh_CN/messages.json'), 'utf8'));
var manifest = JSON.parse(fs.readFileSync(path.join(root, 'vendor/common/manifest.json'), 'utf8'));

function placeholders(message) {
    return (message.match(/\$\d+/g) || []).sort();
}

function assertHtmlI18n(file) {
    var html = fs.readFileSync(path.join(root, file), 'utf8');
    assert(/<meta\s+charset=["']utf-8["']\s*>/i.test(html), file + ' must declare UTF-8');
    assert(/<html\s+lang=["']en["']/i.test(html), file + ' must have an English source-language hint');
    assert(!/[\uFFFD]/.test(html), file + ' must not contain replacement characters');
    var keyPattern = /data-i18n(?:-[a-z-]+)?=["']([^"']+)["']/g;
    var match;
    while((match = keyPattern.exec(html))) {
        assert(english[match[1]], file + ' refers to missing English message key ' + match[1]);
        assert(chinese[match[1]], file + ' refers to missing Chinese message key ' + match[1]);
    }
}

function loadTranslator(mockGetMessage) {
    global.chrome = { i18n: { getMessage: mockGetMessage } };
    var translatorPath = require.resolve('../js/translator');
    delete require.cache[translatorPath];
    return require('../js/translator');
}

assert.strictEqual(manifest.default_locale, 'en', 'English remains the manifest fallback locale');
assert.deepStrictEqual(Object.keys(chinese).sort(), Object.keys(english).sort(), 'Simplified Chinese must cover every English message key');
Object.keys(english).forEach(function(key) {
    assert.strictEqual(typeof english[key].message, 'string', key + ' must have an English message');
    assert.strictEqual(typeof chinese[key].message, 'string', key + ' must have a Chinese message');
    assert.deepStrictEqual(placeholders(chinese[key].message), placeholders(english[key].message), key + ' placeholder parity');
    assert(!/[\uFFFD]/.test(english[key].message), key + ' English message must not contain replacement characters');
    assert(!/[\uFFFD]/.test(chinese[key].message), key + ' Chinese message must not contain replacement characters');
});
assertHtmlI18n('options.html');
assertHtmlI18n('popin.html');
assert(chinese.webdav_title.message.includes('WebDAV'), 'WebDAV UI must have a Simplified Chinese translation');
assert(chinese.vault_create_button.message.includes('创建'), 'Vault controls must have a Simplified Chinese translation');

var zhTranslator = loadTranslator(function(key, substitutions) {
    var entry = chinese[key];
    if(!entry) return '';
    var result = entry.message;
    (substitutions || []).forEach(function(value, index) {
        result = result.replace(new RegExp('\\$' + (index + 1) + '(?!\\d)', 'g'), String(value));
    });
    return result;
});
assert.strictEqual(zhTranslator.translate('webdav_title'), chinese.webdav_title.message);
assert.strictEqual(zhTranslator.translateText('WebDAV read failed (HTTP 503).'), 'WebDAV 读取失败（HTTP 503）。');
assert.strictEqual(zhTranslator.translateText('Could not read Vault status: Vault is not configured.'), '无法读取保险库状态：保险库尚未设置。', 'nested Vault errors should also be translated');
assert.strictEqual(
    zhTranslator.translateText('Replace this device’s credentials with 4 entries from the encrypted WebDAV file? A local backup will be kept.'),
    '要用加密 WebDAV 文件中的 4 条凭据替换此设备上的凭据吗？本地备份会保留。'
);

var fallbackTranslator = loadTranslator(function(key) { return key; });
assert.strictEqual(fallbackTranslator.translate('webdav_title'), english.webdav_title.message, 'missing UI-language message must fall back to English');
assert.strictEqual(fallbackTranslator.translateText('Unmapped runtime text.'), 'Unmapped runtime text.', 'unknown runtime copy must remain readable');

process.stdout.write('i18n tests passed: UTF-8 pages, complete locale parity, dynamic placeholders, Simplified Chinese and English fallback.\n');
