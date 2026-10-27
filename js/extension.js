/*global Promise*/
'use strict';

var CredentialStorage = require('./credential_storage');
var WebDAVSync = require('./webdav_sync');
var AuthPolicy = require('./auth_policy');
var Vault = require('./vault');

// the popin and option pane needs this to save the temporary item
// window.Storage = require('./storage');

var Extension = function () {
    var statuses = {};
    var max_try = 5;
    var manifestVersion = chrome.runtime.getManifest().manifest_version;
    var toolbarAction = chrome[manifestVersion >= 3 ? 'action' : 'browserAction'];

    function showBadeForTab(tab) {
        showBadge(tab.id, tab.url);
    }

    function showBadgeForTabId(tab_id) {
        chrome.tabs.get(tab_id, showBadeForTab);
    }

    function showBadgeForStatus(status) {
        showBadgeForTabId(status.tabId);
    }

    function showBadge(tab_id, url) {
        var matches = Object.prototype.hasOwnProperty.call(statuses, tab_id) && statuses[tab_id].credentials.length > 0 &&
            AuthPolicy.matchesRule(statuses[tab_id].credentials[0].url, url);

        if (matches) {
            var color = statuses[tab_id].credentials.length > 1 ? '#FFFF00' : '#00FF00';
            if(statuses[tab_id].count > max_try) { // fail
                color = '#FF0000';
            }

            if(toolbarAction && toolbarAction.setBadgeText) toolbarAction.setBadgeText({ text: ' ' });
            if(toolbarAction && toolbarAction.setBadgeBackgroundColor) toolbarAction.setBadgeBackgroundColor({ color: color });
        } else {
            if(toolbarAction && toolbarAction.setBadgeText) toolbarAction.setBadgeText({text: ''});
            delete statuses[tab_id];
        }
    }

    function retrieveCredentials(status) {
        if(!AuthPolicy.isEligibleChallenge(status)) return {};
        var credentials = CredentialStorage.getCredentials(status);

        if(Object.prototype.hasOwnProperty.call(statuses, status.tabId) && statuses[status.tabId].requestId == status.requestId) {
            statuses[status.tabId].count += 1;
        } else {
            statuses[status.tabId] = {
                credentials: credentials.map(function(credential) { return { url: credential.url }; }),
                count: 0,
                requestId: status.requestId
            };
        }

        return credentials.length == 0 || statuses[status.tabId].count > max_try ? {} : {
            authCredentials: {
                username: credentials[0].username,
                password: credentials[0].password
            }
        };
    }

    function retrieveWhenReady(status) {
        if(!AuthPolicy.isEligibleChallenge(status)) return Promise.resolve({});
        return CredentialStorage.ready().then(function() { return retrieveCredentials(status); }).catch(function() { return {}; });
    }

    function suggester(status) {
        if(Object.prototype.hasOwnProperty.call(statuses, status.tabId)) {
            if(statuses[status.tabId].credentials.length == 0) {
                // no credentials found
            } else {
                if (statuses[status.tabId].credentials.length > 1) {
                    // multiple credentials
                }

                if (statuses[status.tabId].count > max_try) {
                    // failed authentication
                } else {
                    // authentication sent
                }
            }
        }
    }

    function init() {
        Vault.onLock(function() {
            statuses = {};
            if(toolbarAction && toolbarAction.setBadgeText) toolbarAction.setBadgeText({ text: '' });
        });
        if(!chrome.webRequest || !chrome.webRequest.onAuthRequired || !chrome.webRequest.onCompleted) {
            if(toolbarAction && toolbarAction.setBadgeText) toolbarAction.setBadgeText({ text: '!' });
            return;
        }
        WebDAVSync.initBackground(CredentialStorage).catch(function() {});
        if(manifestVersion >= 3) {
            chrome.webRequest.onAuthRequired.addListener(function(status, callback) {
                if(typeof callback !== 'function') return;
                var replied = false;
                var timer = setTimeout(function() { respond({}); }, 5000);
                function respond(value) { if(replied) return; replied = true; clearTimeout(timer); callback(value); }
                retrieveWhenReady(status).then(respond, function() { respond({}); });
            }, {urls: ['https://*/*']}, ['asyncBlocking']);
        } else {
            // The legacy MV2 package is Firefox Android, which accepts a Promise in blocking mode.
            chrome.webRequest.onAuthRequired.addListener(retrieveWhenReady, {urls: ['https://*/*']}, ['blocking']);
        }

        chrome.webRequest.onCompleted.addListener(suggester, {urls: ['https://*/*']});

        chrome.tabs.onUpdated.addListener(showBadgeForTabId);
        chrome.tabs.onActivated.addListener(showBadgeForStatus);
    }

    return {
        'init': init
    };
}();

Extension.init();
