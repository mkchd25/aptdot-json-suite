/*!
 * Aptdot share-link guard (reference copy).
 * On aptdot.com this runs inline at the very top of <head> on the JSON tool
 * pages (printed by the WordPress plugin), before any ad or analytics script.
 * It removes #data= / ?data= from the address bar and hands the data to
 * json-formatter.js through window.__aptdotShareStash.
 */
(function () {
  try {
    var l = window.location;
    if (!/(^#|&)data=/.test(l.hash) && !/(^\?|&)data=/.test(l.search)) return;
    window.__aptdotShareStash = { hash: l.hash, search: l.search };
    var strip = function (part, mark) {
      var p = new URLSearchParams(part.replace(/^[#?]/, ''));
      if (p.get('data') === null) return part;
      p['delete']('data');
      var rest = p.toString();
      return rest ? mark + rest : '';
    };
    window.history.replaceState(window.history.state, '', l.pathname + strip(l.search, '?') + strip(l.hash, '#'));
  } catch (e) { /* the tool removes it later instead */ }
})();
