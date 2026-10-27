'use strict';

var assert = require('assert');
var childProcess = require('child_process');
var fs = require('fs');
var os = require('os');
var path = require('path');
var root = path.resolve(__dirname, '..');
var temp = fs.mkdtempSync(path.join(os.tmpdir(), 'multipass-i18n-package-'));
var platforms = ['chrome', 'firefox', 'opera', 'firefox-android'];

function assertBuiltPackage(platform) {
    var buildDir = path.join(root, 'build', platform);
    assert(fs.existsSync(buildDir), 'Run npm run build and npm run build:firefox-android before package checks (' + platform + ')');
    var manifest = JSON.parse(fs.readFileSync(path.join(buildDir, 'manifest.json'), 'utf8'));
    assert.strictEqual(manifest.default_locale, 'en', platform + ' must keep English as the default locale');
    ['options.html', 'popin.html'].forEach(function(page) {
        var html = fs.readFileSync(path.join(buildDir, page), 'utf8');
        assert(/<meta\s+charset=["']utf-8["']\s*>/i.test(html), platform + '/' + page + ' must declare UTF-8');
    });
    var english = JSON.parse(fs.readFileSync(path.join(buildDir, '_locales/en/messages.json'), 'utf8'));
    var chinesePath = path.join(buildDir, '_locales/zh_CN/messages.json');
    assert(fs.existsSync(chinesePath), platform + ' must package the Simplified Chinese locale');
    var chinese = JSON.parse(fs.readFileSync(chinesePath, 'utf8'));
    assert.deepStrictEqual(Object.keys(chinese).sort(), Object.keys(english).sort(), platform + ' locale key parity');

    var archive = path.join(temp, platform + '.zip');
    childProcess.execFileSync('zip', ['-qr', archive, '.'], { cwd: buildDir });
    var members = childProcess.execFileSync('unzip', ['-Z1', archive], { encoding: 'utf8' }).split(/\r?\n/);
    assert(members.includes('_locales/zh_CN/messages.json'), platform + ' archive must contain the Simplified Chinese locale');
    assert(members.includes('options.html') && members.includes('popin.html'), platform + ' archive must contain both UTF-8 UI pages');
    var packagedText = childProcess.execFileSync('unzip', ['-p', archive, '_locales/zh_CN/messages.json'], { encoding: 'utf8' });
    assert.strictEqual(JSON.parse(packagedText).webdav_title.message, chinese.webdav_title.message, platform + ' archive locale must be readable JSON');
}

try {
    platforms.forEach(assertBuiltPackage);
    process.stdout.write('Package i18n tests passed: Chrome/Edge, Firefox, Opera and Firefox Android archives include UTF-8 pages and complete zh_CN resources.\n');
} finally {
    fs.rmSync(temp, { recursive: true, force: true });
}
