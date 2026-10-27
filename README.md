# MultiPass WebDAV Sync

URL-rule-based HTTP Basic authentication for HTTP and HTTPS websites, with an encrypted local vault and optional encrypted WebDAV synchronization.

This is an unofficial fork of [MultiPass for HTTP Basic Authentication](https://github.com/krtek4/MultiPass), published by **xiongmx**. The upstream project is not the publisher of this fork. The upstream WTFPL v2 attribution is retained.

[中文说明](README.zh-CN.md) · [Privacy policy](https://xiongmx.github.io/multipass-webdav-sync/privacy-policy.html)

## Use

1. Create a vault with a password you can remember. There is no password-recovery backdoor.
2. Add URL-matching rules and HTTP Basic credentials for trusted websites. On plain HTTP, credentials are sent without transport encryption; prefer HTTPS.
3. Unlock the vault after restarting the browser. A matching origin-server Basic authentication challenge can receive saved credentials using the challenged website's HTTP or HTTPS protocol.
4. Optionally authorize WebDAV synchronization separately on each device and configure your own HTTPS WebDAV file URL and account. The server must support GET, PUT, conditional requests, and strong ETags.

Rules can match HTTP and HTTPS websites. Proxy-authentication and non-Basic challenges are rejected. The extension does not read page text or form contents.

## Vault and synchronization

Version 1.1.2 uses AES-GCM-256 with a random 16-byte salt and 12-byte IV. The chosen vault password is first processed with SHA-256 and then used as input to PBKDF2-HMAC-SHA-256 with 600,000 iterations. The original vault password is not stored or sent to WebDAV. Password-derived root material is held in trusted extension session storage; restarting the browser locks the vault.

Local credential rules, WebDAV account values, temporary values, backups, synchronization metadata, JSON exports, and WebDAV synchronization files are encrypted. The WebDAV provider still receives its own account authorization and can observe the endpoint, request timing and size, and metadata such as ETags. ETags and hashes detect changes and conflicts; they are not encryption and do not prevent a malicious rollback.

Synchronization stops on conflicts, missing or inconsistent baselines, weak or missing ETags, remote deletion, or other safety checks instead of silently selecting the latest timestamp. Browser alarms are best-effort and may run later than the configured interval.

## Important limits

- Locking the vault stops new credential responses and synchronization attempts, but cannot recall credentials or writes already sent, clear the browser's HTTP-authentication cache, or revoke server sessions.
- Creating the vault migrates legacy local data into encrypted storage. Secure erasure of old bytes in browser, device, or system backups cannot be guaranteed. Existing plaintext remote files are not automatically adopted or overwritten; migration and removal require deliberate user action.
- Revoking WebDAV authorization stops scheduled synchronization and clears local WebDAV account values, metadata, and backups. It does not delete remote files or downloaded/exported copies.
- The extension has not been independently security-audited. Automated tests are not a security certification or a compatibility guarantee.

## Platform status

The current primary package targets Chromium Manifest V3. Edge Android Stable has **not** been verified on a real device, and Android support is not claimed. Responsive desktop captures do not establish mobile compatibility. Firefox and Firefox for Android builds are experimental and require separate validation. iOS Safari is not supported.

## Development

```sh
npm ci
npm test
npm run build
npm run dist
npm run test:packages
```

For the protocol integration tests, install the Python dependencies and run:

```sh
python3 -m pip install -r requirements-webdav-e2e.txt
npm run test:webdav-e2e
```

The integration-test adapter maps a fixed synthetic HTTPS localhost URL to a temporary HTTP loopback test server. It is not shipped with the extension, does not create a product HTTP exception, and does not test a TLS handshake.

## Privacy, support, and license

The extension has no analytics, advertising, telemetry, developer-operated collection endpoint, or browser-account synchronization service. See the [privacy policy](https://xiongmx.github.io/multipass-webdav-sync/privacy-policy.html) for data handling, controls, and limitations.

For support or privacy questions: [multipass@xiongmx.com](mailto:multipass@xiongmx.com).

Licensed under [WTFPL v2](LICENSE). Original upstream author: Gilles Crettenand.
