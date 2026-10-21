/* PHLO Google Maps address search for the driver form.
 * Typing in an address field shows Google's suggestions; picking one fills in the full address and
 * gives back its map pin (lat/lng + place id), which later route planning can use.
 * Also loads the map for drawing driver areas (library('maps')).
 * Only runs when config.js has a mapsApiKey; without one the fields stay plain text boxes. */
(function () {
  'use strict';

  var CFG = window.PHLO_CONFIG || {};
  var KEY = CFG.mapsApiKey || '';
  var failed = '';     // why Maps can't be used, if it failed
  var uid = 0;

  var base = null;     // promise for the Google Maps script itself
  var libs = {};       // loaded libraries by name ('places', 'maps')

  function loadBase() {
    if (failed) return Promise.reject(new Error(failed));
    if (base) return base;
    base = new Promise(function (resolve, reject) {
      // Google calls this when the key is wrong or the domain isn't allowed for it.
      window.gm_authFailure = function () {
        failed = 'Google Maps rejected the key. Check mapsApiKey in config.js and the key\'s allowed websites.';
        if (window.phloMaps.onError) window.phloMaps.onError(failed);
      };
      window.__phloMapsLoaded = function () { resolve(); };
      var s = document.createElement('script');
      s.src = 'https://maps.googleapis.com/maps/api/js?key=' + encodeURIComponent(KEY) +
        '&v=weekly&loading=async&callback=__phloMapsLoaded';
      s.async = true;
      s.onerror = function () { reject(new Error('Could not load Google Maps.')); };
      document.head.appendChild(s);
    }).catch(function (e) {
      failed = failed || e.message || 'Could not load Google Maps.';
      base = null;
      throw new Error(failed);
    });
    return base;
  }

  /** Loads one Google Maps library ('places', 'maps', ...) and gives it back. */
  function library(name) {
    if (!KEY) return Promise.reject(new Error('No Google Maps key in config.js.'));
    if (libs[name]) return libs[name];
    libs[name] = loadBase().then(function () { return google.maps.importLibrary(name); });
    libs[name].catch(function () { delete libs[name]; });
    return libs[name];
  }

  function load() { return library('places'); }

  /** Adds Google suggestions to `input`. onPick({address, lat, lng, placeId}) runs after a pick. */
  function attach(input, onPick) {
    if (!KEY) return;
    var id = 'addr-suggest-' + (++uid);
    var list = document.createElement('ul');
    list.id = id; list.className = 'suggest'; list.setAttribute('role', 'listbox'); list.hidden = true;
    input.parentNode.insertBefore(list, input.nextSibling);
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-controls', id);
    input.setAttribute('aria-expanded', 'false');

    var items = [], active = -1, timer = null, seq = 0, token = null;

    function close() {
      list.hidden = true; list.textContent = ''; items = []; active = -1;
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
    }
    function highlight(i) {
      active = i;
      Array.prototype.forEach.call(list.children, function (li, k) { li.setAttribute('aria-selected', k === i ? 'true' : 'false'); });
      if (i >= 0) input.setAttribute('aria-activedescendant', id + '-' + i); else input.removeAttribute('aria-activedescendant');
    }
    function show(suggestions) {
      list.textContent = '';
      items = suggestions.filter(function (s) { return s.placePrediction; }).slice(0, 5);
      if (!items.length) { close(); return; }
      items.forEach(function (s, i) {
        var p = s.placePrediction;
        var li = document.createElement('li');
        li.id = id + '-' + i; li.setAttribute('role', 'option');
        var main = document.createElement('b'); main.textContent = p.mainText ? p.mainText.toString() : p.text.toString();
        li.appendChild(main);
        if (p.secondaryText) { var sub = document.createElement('span'); sub.textContent = ' ' + p.secondaryText.toString(); li.appendChild(sub); }
        // mousedown, not click, so the input doesn't lose focus and close the list first.
        li.addEventListener('mousedown', function (e) { e.preventDefault(); pick(i); });
        list.appendChild(li);
      });
      list.hidden = false;
      input.setAttribute('aria-expanded', 'true');
      highlight(-1);
    }
    function search() {
      var text = input.value.trim();
      var mine = ++seq;
      if (text.length < 3) { close(); return; }
      load().then(function (places) {
        if (!token) token = new places.AutocompleteSessionToken();
        return places.AutocompleteSuggestion.fetchAutocompleteSuggestions({
          input: text, sessionToken: token, includedRegionCodes: [CFG.mapsRegion || 'us']
        });
      }).then(function (r) {
        if (mine === seq && document.activeElement === input) show(r.suggestions || []);
      }).catch(function (e) {
        close();
        if (window.phloMaps.onError) window.phloMaps.onError(e.message);
      });
    }
    function pick(i) {
      var p = items[i] && items[i].placePrediction;
      if (!p) return;
      close();
      seq++;
      input.value = p.text.toString();
      var place = p.toPlace();
      token = null; // fetching the place ends this search session
      place.fetchFields({ fields: ['formattedAddress', 'location'] }).then(function () {
        var address = place.formattedAddress || input.value;
        input.value = address;
        onPick({ address: address, lat: place.location.lat(), lng: place.location.lng(), placeId: place.id || '' });
      }).catch(function (e) {
        if (window.phloMaps.onError) window.phloMaps.onError('Could not get that address from Google Maps: ' + e.message);
      });
    }

    input.addEventListener('focus', function () { load().catch(function () { /* reported when searching */ }); });
    input.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(search, 250); });
    input.addEventListener('blur', function () { setTimeout(close, 100); });
    input.addEventListener('keydown', function (e) {
      if (list.hidden) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); highlight((active + 1) % items.length); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); highlight(active <= 0 ? items.length - 1 : active - 1); }
      else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); pick(active); }
      else if (e.key === 'Escape') { e.preventDefault(); close(); }
    });
  }

  window.phloMaps = { enabled: !!KEY, attach: attach, library: library, onError: null };
})();
