'use strict';

var englishMessages = require('../_locales/en/messages.json');

module.exports = function() {
    var englishByText = Object.create(null);
    var englishTemplates = [];

    Object.keys(englishMessages).forEach(function(key) {
        var text = englishMessages[key] && englishMessages[key].message;
        if(typeof text !== 'string') return;
        if(!Object.prototype.hasOwnProperty.call(englishByText, text)) englishByText[text] = key;
        if(/\$\d+/.test(text)) englishTemplates.push({ key: key, text: text });
    });

    function normalizeSubstitutions(substitutions) {
        if(typeof substitutions === 'undefined' || substitutions === null) return [];
        return Array.isArray(substitutions) ? substitutions : [substitutions];
    }

    function applySubstitutions(text, substitutions) {
        var values = normalizeSubstitutions(substitutions);
        return text.replace(/\$(\d+)/g, function(match, number) {
            var index = Number(number) - 1;
            return index >= 0 && index < values.length ? String(values[index]) : match;
        });
    }

    function translate(key, substitutions) {
        var values = normalizeSubstitutions(substitutions);
        var localized = '';
        try {
            if(typeof chrome !== 'undefined' && chrome.i18n && typeof chrome.i18n.getMessage === 'function') {
                localized = values.length ? chrome.i18n.getMessage(key, values) : chrome.i18n.getMessage(key);
            }
        } catch(error) {
            localized = '';
        }
        if(localized && localized !== key) return localized;
        var fallback = englishMessages[key] && englishMessages[key].message;
        return typeof fallback === 'string' ? applySubstitutions(fallback, values) : key;
    }

    function matchTemplate(template, text) {
        var pieces = template.split(/(\$\d+)/g);
        var pattern = '^';
        var placeholderNumbers = [];
        pieces.forEach(function(piece) {
            if(/^\$\d+$/.test(piece)) {
                pattern += '([\\s\\S]+?)';
                placeholderNumbers.push(Number(piece.slice(1)));
            } else {
                pattern += piece.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            }
        });
        var match = text.match(new RegExp(pattern + '$'));
        if(!match) return null;
        var substitutions = [];
        placeholderNumbers.forEach(function(number, index) { substitutions[number - 1] = match[index + 1]; });
        return substitutions;
    }

    function translateText(text, substitutions) {
        if(typeof text !== 'string') return text;
        var key = englishByText[text];
        if(key) return translate(key, substitutions);
        if(typeof substitutions === 'undefined') {
            for(var i = 0; i < englishTemplates.length; i++) {
                var values = matchTemplate(englishTemplates[i].text, text);
                if(values) return translate(englishTemplates[i].key, values.map(function(value) { return typeof value === 'string' ? translateText(value) : value; }));
            }
        }
        return applySubstitutions(text, substitutions);
    }

    function translateAttribute(attribute, keyAttribute) {
        if(typeof document === 'undefined' || !document.querySelectorAll) return;
        [].forEach.call(document.querySelectorAll('[' + keyAttribute + ']'), function(element) {
            var key = element.getAttribute(keyAttribute);
            var value = translate(key);
            if(attribute === 'textContent') element.textContent = value;
            else element.setAttribute(attribute, value);
        });
    }

    function translateHtml() {
        if(typeof document === 'undefined' || !document.querySelectorAll) return;
        translateAttribute('textContent', 'data-i18n');
        translateAttribute('placeholder', 'data-i18n-placeholder');
        translateAttribute('title', 'data-i18n-title');
        translateAttribute('aria-label', 'data-i18n-aria-label');
        try {
            if(document.documentElement && typeof chrome !== 'undefined' && chrome.i18n && typeof chrome.i18n.getUILanguage === 'function') {
                document.documentElement.lang = chrome.i18n.getUILanguage();
            }
        } catch(error) { /* The language hint is optional. */ }
    }

    translateHtml();

    return {
        translate: translate,
        translateText: translateText,
        translateHtml: translateHtml
    };
}();
