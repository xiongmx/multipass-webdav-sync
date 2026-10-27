'use strict';

function isHttpsUrl(url) {
    if(typeof url !== 'string' || !/^https:\/\//i.test(url)) return false;
    try {
        var parsed = new URL(url);
        return parsed.protocol === 'https:' && parsed.hostname.length > 0 && !parsed.username && !parsed.password;
    } catch(error) {
        return false;
    }
}

function matchesRule(pattern, url) {
    if(!isHttpsUrl(url) || typeof pattern !== 'string') return false;
    try {
        return new RegExp(pattern).test(url);
    } catch(error) {
        return false;
    }
}

function isEligibleChallenge(status) {
    return !!status && isHttpsUrl(status.url) && status.isProxy === false &&
        typeof status.scheme === 'string' && status.scheme.toLowerCase() === 'basic';
}

module.exports = {
    DEFAULT_RULE: '^https://',
    isHttpsUrl: isHttpsUrl,
    matchesRule: matchesRule,
    isEligibleChallenge: isEligibleChallenge
};
