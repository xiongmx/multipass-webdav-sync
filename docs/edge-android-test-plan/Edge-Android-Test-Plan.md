# Edge Android Extension — Proposed Core-Function Test Plan

**Extension:** MultiPass WebDAV Sync  
**Edge Add-ons Store ID:** `ojcoicjidcijdeocdjdcldokedjmcgcb`  
**Document status:** Draft for owner review; not submitted to Microsoft  
**Target platform for these cases:** Microsoft Edge Canary for Android  
**iOS status:** No — iOS is out of scope and no iOS compatibility is claimed.

> **Important test-status notice.** The owner reports that the extension has been tested successfully in Microsoft Edge Canary for Android. The device, Android build, Edge Canary version, extension package version, date, and individual checks were not supplied here, so that general report is not converted into detailed case-level pass results. Every test case below is **proposed and not yet executed** for this plan. Edge Stable has not been validated. This document is a test plan, not a test report, compatibility certification, or security audit.

## 1. Purpose and boundaries

This plan gives Microsoft Edge Android QA reproducible core-function scenarios for MultiPass WebDAV Sync. It focuses on installation and update, HTTP Basic authentication rules, vault locking, encrypted JSON import, optional WebDAV synchronization, and safe handling of conflicts and failed verification.

Run only against a dedicated test build and non-production test accounts. Use HTTPS test origins and a test WebDAV endpoint. Do not use real user credentials. Record the exact package and environment before execution. A case passes only when its stated observations are captured on the actual device; source-code review or desktop testing alone is not a pass.

## 2. Execution record (complete during testing)

- Test date/time and time zone: **Not recorded — fill in during execution**
- Tester: **Not recorded — fill in during execution**
- Android device model and OS/build: **Not recorded — fill in during execution**
- Edge channel and full version: **Edge Canary for Android; exact version not recorded**
- Extension package/version and package source: **Not recorded — fill in during execution**
- Test WebDAV server/software and TLS certificate status: **Not recorded — fill in during execution**
- Test origin(s): **Not recorded — use controlled HTTPS Basic-auth test endpoints**
- Evidence location (redact credentials, tokens, and sensitive URLs): **Not recorded**

## 3. Test cases

### TC-01 — Install and first launch on Edge Canary for Android

**Status:** Proposed; not executed in this plan.  
**Objective:** Confirm that the specific test package can be installed and started in the intended Android Canary environment.

**Preconditions:** Record device, Android build, Edge Canary full version, package version, package origin, and installation method. Use a package intended for the test and a fresh or disposable browser profile where practical.

**Steps:**
1. Install the test extension package in Edge Canary for Android using the supported local-development procedure for that build.
2. Confirm the extension appears in Edge's extension management UI and is enabled.
3. Open the extension UI and complete first-use vault setup with a test-only password and test data.
4. Close and reopen the extension UI; observe whether it loads without an error.

**Expected observations:** The intended package/version is shown as installed and enabled; the extension UI opens; vault setup can be completed; there is no crash or blocking error. Record any platform prompts or limitations exactly as shown.

**Result/evidence:** Not executed — no pass/fail result or evidence recorded.

### TC-02 — Update an installed test build

**Status:** Proposed; not executed in this plan.  
**Objective:** Check update behavior without confusing it with a fresh install.

**Preconditions:** TC-01 completed on a disposable test profile; a later test package is available. Record both package versions. Back up only disposable test data.

**Steps:**
1. Install and configure the earlier test package with a non-sensitive test rule and test vault data.
2. Update it to the later test package using the supported Edge Canary development workflow.
3. Verify the extension reports the later version.
4. Reopen the extension UI and verify the test vault and rule behavior.

**Expected observations:** The intended later version is installed and loads. Existing test data remains available if the update path is designed to preserve it; any migration prompt or intentional reset is recorded rather than assumed. No credentials are exposed in screenshots or logs.

**Result/evidence:** Not executed — no pass/fail result or evidence recorded.

### TC-03 — Matching HTTP Basic challenge and URL-rule boundaries

**Status:** Proposed; not executed in this plan.  
**Objective:** Verify the core authentication flow on Android and confirm credentials are limited to matching rules and supported challenges.

**Preconditions:** A controlled HTTPS origin with HTTP Basic authentication; a second non-matching test origin or rule; disposable credentials; vault unlocked; no production accounts. Record the test rule's exact matching conditions without recording its password.

**Steps:**
1. Create a URL rule for the controlled test origin and enter its disposable HTTP Basic username and password.
2. Open a protected resource on the matching HTTPS origin.
3. Confirm whether the expected test resource loads and record the observed challenge/result.
4. Visit a different non-matching HTTPS origin (or a URL outside the configured rule) that presents its own test challenge.
5. If a controlled test environment is available, verify that a proxy-authentication or non-Basic challenge is not automatically answered by the extension.

**Expected observations:** The extension supplies the configured test credentials only when a supported Basic challenge matches the configured rule and the vault is unlocked. It does not send those credentials to a non-matching origin/rule, a proxy challenge, or a non-Basic challenge. Record prompts, failures, and browser-version-specific behavior without treating a manual user entry as an extension pass.

**Result/evidence:** Not executed — no pass/fail result or evidence recorded.

### TC-04 — Vault state after restart and manual lock

**Status:** Proposed; not executed in this plan.  
**Objective:** Verify the current build's intended persistent-unlock behavior and confirm manual locking stops protected operations.

**Preconditions:** Test vault and test authentication rule configured; disposable HTTPS Basic-auth origin; record whether the build provides a persistent-unlock setting or state. Do not use a production vault.

**Steps:**
1. Unlock the test vault and confirm the matching test rule can handle its controlled Basic challenge.
2. Close and fully restart Edge Canary. Reopen the extension and observe the vault state before entering a password.
3. If the vault remains unlocked by design, repeat the controlled test challenge and record the result. If it is locked, record that behavior instead of bypassing it.
4. Use the extension's explicit **Lock Vault** action.
5. Repeat the controlled challenge and attempt a WebDAV sync, if configured, while the vault is locked.
6. Restart Edge Canary and check the vault state again.

**Expected observations:** Record whether the current build retains the unlocked state across restart. After manual lock, stored credentials are not supplied and synchronization does not proceed until the vault is unlocked again; after restart, record the observed lock/unlock state. Any mismatch with the build's documented behavior is a failure to investigate, not a pass.

**Result/evidence:** Not executed — no pass/fail result or evidence recorded.

### TC-05 — Encrypted JSON import without camera permission

**Status:** Proposed; not executed in this plan.  
**Objective:** Verify that importing a test JSON backup uses Android file selection and does not require camera access.

**Preconditions:** A valid test-only JSON export prepared by the extension; a disposable vault/profile; access to Android's file picker. Do not include real credentials in test files.

**Steps:**
1. Review the extension's Android permission/app-permission information before import and record whether Camera permission is present or granted.
2. From the extension's import control, select the test JSON file through the Android file picker.
3. Complete any expected vault/password confirmation using test-only data.
4. Compare the imported test rule/settings with the source test export.
5. Review the permission state again and note any permission prompt.

**Expected observations:** Import can be initiated through file selection and the expected test data is available afterward. The import flow does not request camera access; no camera permission is required or granted for JSON import. Record an import error or unexpected permission request as a failure; do not bypass it without documenting it.

**Result/evidence:** Not executed — no pass/fail result or evidence recorded.

### TC-06 — HTTPS WebDAV setup and conditional ETag synchronization

**Status:** Proposed; not executed in this plan.  
**Objective:** Verify opt-in synchronization with the user's own HTTPS WebDAV endpoint and its conditional-write behavior.

**Preconditions:** A dedicated HTTPS WebDAV test endpoint with a valid certificate, a disposable test account, and server-side logging that can be safely redacted. Vault unlocked; synchronization explicitly enabled by the tester. Do not use a live WebDAV account or expose Authorization headers, passwords, or vault secrets in evidence.

**Steps:**
1. Configure the test HTTPS WebDAV URL and disposable WebDAV account in the extension.
2. Run a first manual synchronization and record the UI result and HTTP status/ETag metadata from redacted server logs.
3. Confirm that the test file stored remotely is encrypted and that no vault password or plaintext test credential is included in it.
4. Change one non-sensitive test rule locally and synchronize again.
5. Inspect redacted logs to determine whether the write is conditional on a strong ETag (for example, an `If-Match`/`If-None-Match` condition, as applicable) rather than an unconditional blind overwrite.
6. If safe in the test environment, try configuring an HTTP (non-HTTPS) endpoint or a redirecting endpoint and record whether the extension rejects it without sending WebDAV credentials to an unintended destination.

**Expected observations:** The opt-in sync succeeds against the configured HTTPS test server; the remote payload remains encrypted; the server receives only the WebDAV authorization needed for that endpoint; the vault password is not sent. Subsequent writes use conditional ETag protection. Any HTTP/redirect behavior is recorded; credentials must not be forwarded to an unintended origin. Never include secrets in test evidence.

**Result/evidence:** Not executed — no pass/fail result or evidence recorded.

### TC-07 — Conflict and unsafe remote-state handling

**Status:** Proposed; not executed in this plan.  
**Objective:** Confirm that concurrent edits and unsafe remote states stop synchronization rather than silently choosing a last-write-wins result.

**Preconditions:** Dedicated test WebDAV endpoint; disposable test vault data. Prepare independent local and remote changes. Use server-side controls or a staging endpoint to simulate a missing/weak/inconsistent ETag or an altered read-back response. Do not run fault injection against a production account.

**Steps:**
1. Create a baseline synchronized test file.
2. Make a local test-rule change, then independently alter the remote test file from a second client before the Android client syncs.
3. Attempt synchronization and record the error/conflict indication.
4. Verify that both the local change and remote test file remain available for inspection and that no silent overwrite is reported as success.
5. In a separate run, simulate a missing/weak/inconsistent ETag or a read-back payload that does not match the attempted write.
6. Attempt synchronization and inspect the final local and remote test states.

**Expected observations:** The extension stops or reports a conflict/verification failure when it cannot safely establish a strong conditional baseline or verify the written result. It does not silently overwrite one side, claim a successful sync for an unverified write, or discard the only test copy. Record the exact error and preserve redacted logs for investigation.

**Result/evidence:** Not executed — no pass/fail result or evidence recorded.

### TC-08 — iOS status and scope control

**Status:** Out of scope; no iOS execution or compatibility claim.  
**Objective:** Prevent Android results from being represented as iOS validation.

**Expected statement:** The owner selected **No** for “Does your extension function as expected on Edge iOS?” No iOS test is claimed by this plan. An Android Canary result does not establish iOS compatibility.

## 4. Evidence and reporting checklist

For every executed case, record the actual date, device/Android build, Edge channel and full version, extension package/version, steps completed, observed result, and evidence file names. Redact usernames, passwords, authorization headers, vault secrets, private WebDAV paths, and any personal data. Mark each case **Pass**, **Fail**, or **Blocked** only after execution; include a short factual note for failures or platform limitations.

## 5. Review and submission note

This local draft is not a public download link. Microsoft’s form asks for a viewable/downloadable test-case link. Do not enter a link or submit the request until the owner reviews this plan, decides whether to execute the proposed cases, and chooses an approved hosting location if a link is still required.
