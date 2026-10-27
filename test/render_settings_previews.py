#!/usr/bin/env python3
"""Render the current Chrome options page in deterministic, isolated fixtures.

This script deliberately copies build/chrome to a temporary directory before
injecting the Chrome API mock. It never changes build/, dist/, source files, or
the user's browser profile. It is intentionally not run as part of the test
suite; invoke it after the final build when preview images are wanted.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile
from playwright.sync_api import sync_playwright
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CHROME = ROOT / "build" / "chrome"
OUTPUT = Path(os.environ.get("MULTIPASS_PREVIEW_OUTPUT", str(ROOT / "artifacts" / "ui")))
CHROMIUM = Path("/usr/bin/chromium")
PASSPHRASE = "dummy preview vault phrase only"


def node_fixture() -> dict:
    """Ask Node to create a real vault with js/vault.js and return safe fixtures."""
    vault_path = str((ROOT / "js" / "vault.js").resolve())
    helper = r'''
const crypto = require('crypto').webcrypto;
require(process.argv[4]).installGlobalWebLocks();
if (!global.crypto) Object.defineProperty(global, 'crypto', { value: crypto, configurable: true });
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const localData = Object.create(null), sessionData = Object.create(null), listeners = [];
const runtime = { lastError: null };
function emit(changes, area) { listeners.slice().forEach(fn => fn(clone(changes), area)); }
function store(data, area) {
  return {
    get(keys, cb) {
      const names = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(data);
      const result = {};
      names.forEach(key => { if (Object.prototype.hasOwnProperty.call(data, key)) result[key] = clone(data[key]); });
      cb(result);
    },
    set(values, cb) {
      const changes = {};
      Object.keys(values).forEach(key => {
        changes[key] = { oldValue: clone(data[key]), newValue: clone(values[key]) };
        data[key] = clone(values[key]);
      });
      emit(changes, area); cb();
    },
    remove(keys, cb) {
      const changes = {};
      (Array.isArray(keys) ? keys : [keys]).forEach(key => {
        changes[key] = { oldValue: clone(data[key]) }; delete data[key];
      });
      emit(changes, area); cb();
    },
    setAccessLevel() { return Promise.resolve(); }
  };
}
global.chrome = { runtime, storage: {
  local: store(localData, 'local'), session: store(sessionData, 'session'),
  onChanged: { addListener(fn) { listeners.push(fn); } }
} };
(async () => {
  const Vault = require(process.argv[2]);
  await Vault.ready();
  await Vault.create(process.argv[3]);
  process.stdout.write(JSON.stringify({ local: localData, session: sessionData }));
})().catch(error => { process.stderr.write(error.stack || String(error)); process.exit(1); });
'''
    with tempfile.TemporaryDirectory(prefix="multipass-vault-fixture-") as temp:
        helper_path = Path(temp) / "make_fixture.js"
        helper_path.write_text(helper, encoding="utf-8")
        result = subprocess.run(
            ["node", str(helper_path), vault_path, PASSPHRASE, str(ROOT / "test/helpers/web_locks.js")],
            check=True,
            capture_output=True,
            text=True,
        )
    # Only synthetic dummy material is captured here; it is embedded in a
    # temporary preview page and deleted with that isolated preview directory.
    return json.loads(result.stdout)


def chrome_mock(local: dict, session: dict, messages: dict, manifest: dict, ui_language: str) -> str:
    return """<script>
(() => {
  const localData = %s, sessionData = %s, messageData = %s;
  const listeners = [];
  const copy = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  const emit = (changes, area) => listeners.slice().forEach(fn => fn(copy(changes), area));
  function area(data, name) {
    return {
      get(keys, cb) {
        const names = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(data);
        const result = {};
        names.forEach(key => { if (Object.prototype.hasOwnProperty.call(data, key)) result[key] = copy(data[key]); });
        cb(result);
      },
      set(values, cb) {
        const changes = {};
        Object.keys(values).forEach(key => { changes[key] = { oldValue: copy(data[key]), newValue: copy(values[key]) }; data[key] = copy(values[key]); });
        emit(changes, name); cb && cb();
      },
      remove(keys, cb) {
        const changes = {};
        (Array.isArray(keys) ? keys : [keys]).forEach(key => { changes[key] = { oldValue: copy(data[key]) }; delete data[key]; });
        emit(changes, name); cb && cb();
      },
      setAccessLevel() { return Promise.resolve(); }
    };
  }
  const alarmListeners = [];
  window.chrome = {
    runtime: {
      lastError: null,
      getManifest: () => (%s),
      getURL: path => new URL(path, document.baseURI).href
    },
    i18n: {
      getMessage: (key, substitutions) => {
        const item = messageData[key];
        if (!item || !item.message) return '';
        let message = item.message;
        (substitutions || []).forEach((value, index) => { message = message.replace(new RegExp('\\$' + (index + 1) + '(?!\\d)', 'g'), String(value)); });
        return message;
      },
      getUILanguage: () => (%s)
    },
    storage: { local: area(localData, 'local'), session: area(sessionData, 'session'), onChanged: { addListener: fn => listeners.push(fn) } },
    alarms: { create: () => {}, clear: (name, cb) => cb && cb(true), get: (name, cb) => cb && cb(null), onAlarm: { addListener: fn => alarmListeners.push(fn), removeListener: fn => { const i = alarmListeners.indexOf(fn); if (i >= 0) alarmListeners.splice(i, 1); } } }
  };
})();
</script>""" % (json.dumps(local), json.dumps(session), json.dumps(messages), json.dumps(manifest), json.dumps(ui_language))


def dom_probe() -> str:
    return r'''<script>
(() => {
  function mark() {
    const root = document.getElementById('vault-ui');
    if (!root) return;
    const passwordInputs = root.querySelectorAll('input[type="password"]').length;
    const state = passwordInputs === 2 ? 'setup' : passwordInputs === 1 ? 'locked' : root.querySelector('button') ? 'unlocked' : 'unknown';
    root.dataset.vaultState = state;
    document.documentElement.dataset.renderScrollWidth = String(document.documentElement.scrollWidth);
    document.documentElement.dataset.renderHeight = String(Math.max(document.documentElement.scrollHeight, document.body.scrollHeight));
  }
  new MutationObserver(mark).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  document.addEventListener('DOMContentLoaded', mark);
  mark();
})();
</script>'''


def prepare_page(temp_chrome: Path, fixture: dict, messages: dict, ui_language: str) -> None:
    page = temp_chrome / "options.html"
    html = page.read_text(encoding="utf-8")
    needle = '<script type="text/javascript" src="js/option.js"></script>'
    manifest = json.loads((temp_chrome / "manifest.json").read_text(encoding="utf-8"))
    replacement = chrome_mock(fixture["local"], fixture["session"], messages, manifest, ui_language) + needle + dom_probe()
    if needle not in html:
        raise AssertionError("options.html no longer contains the real option.js script tag")
    page.write_text(html.replace(needle, replacement), encoding="utf-8")


def render(temp_chrome: Path, width: int, expected: str, destination: Path, ui_language: str) -> None:
    # Playwright launches a fresh temporary browser profile, never the user's profile.
    with sync_playwright() as runtime:
        browser = runtime.chromium.launch(executable_path=str(CHROMIUM), headless=True,
            args=["--no-sandbox", "--allow-file-access-from-files", "--disable-background-networking"])
        context = browser.new_context(viewport={"width": width, "height": 1000 if width > 640 else 844}, device_scale_factor=1)
        context.route("**/*", lambda route: route.abort() if route.request.url.startswith(("http://", "https://")) else route.continue_())
        page = context.new_page()
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.goto((temp_chrome / "options.html").as_uri(), wait_until="domcontentloaded", timeout=15000)
        try:
            page.wait_for_function("expected => { const el = document.getElementById('vault-ui'); return el && el.dataset.vaultState === expected; }", arg=expected, timeout=15000)
        except Exception as error:
            raise RuntimeError(json.dumps({"pageErrors": errors, "vaultText": page.locator("#vault-ui").all_text_contents(), "ready": page.evaluate("document.readyState")}, ensure_ascii=False)) from error
        page.evaluate("document.fonts.ready")
        metrics = page.evaluate("({width: innerWidth, scroll: document.documentElement.scrollWidth, height: Math.max(document.documentElement.scrollHeight,document.body.scrollHeight)})")
        if metrics["width"] != width or metrics["scroll"] > width:
            raise AssertionError(f"Incorrect viewport or horizontal overflow: {metrics}")
        rendered_text = page.locator("body").inner_text()
        if "\ufffd" in rendered_text:
            raise AssertionError("Rendered UI contains a Unicode replacement character")
        if page.evaluate("document.documentElement.lang") != ui_language:
            raise AssertionError("The document language was not updated to the selected UI locale")
        destination.parent.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(destination), full_page=True)
        context.close()
        browser.close()
    print(f"Rendered {expected}: {width}x{metrics['height']}, no horizontal overflow -> {destination}", flush=True)


def main() -> None:
    if not CHROME.is_dir() or not (CHROME / "options.html").is_file():
        raise FileNotFoundError(f"Expected built Chrome page at {CHROME}")
    if not CHROMIUM.is_file():
        raise FileNotFoundError(f"Chromium not found at {CHROMIUM}")
    locale_messages = {
        "en": json.loads((CHROME / "_locales" / "en" / "messages.json").read_text(encoding="utf-8")),
        "zh_CN": json.loads((CHROME / "_locales" / "zh_CN" / "messages.json").read_text(encoding="utf-8")),
    }
    generated = node_fixture()
    fixtures = {
        "setup": {"local": {}, "session": {}},
        "locked": {"local": generated["local"], "session": {}},
        "unlocked": generated,
    }
    with tempfile.TemporaryDirectory(prefix="multipass-settings-preview-") as temp:
        root = Path(temp)
        for locale, messages in locale_messages.items():
            ui_language = "zh-CN" if locale == "zh_CN" else "en"
            for name, width, expected, output_name in [
                ("setup", 1440, "setup", "setup-desktop"),
                ("locked", 390, "locked", "mobile-locked"),
                ("unlocked", 390, "unlocked", "mobile-unlocked"),
            ]:
                isolated = root / locale / name / "chrome"
                shutil.copytree(CHROME, isolated)
                prepare_page(isolated, fixtures[name], messages, ui_language)
                destination = OUTPUT / f"options-{locale}-{output_name}.png"
                render(isolated, width, expected, destination, ui_language)
    print(f"Rendered English and Simplified Chinese settings previews to {OUTPUT}")


if __name__ == "__main__":
    main()
