/*!
 * Aptdot JSON & Schema Suite - unified workbench engine (v2).
 *
 * Changes from v1:
 *  - No user-derived text ever reaches innerHTML unescaped (fixes XSS via parse
 *    errors and linter messages).
 *  - Share links use base64url and decode correctly ('+', '%', non-ASCII);
 *    old v1 links still open.
 *  - localStorage is optional: blocked storage no longer stops the tool.
 *  - Input is parsed as-is first; trailing commas are repaired only on failure,
 *    outside strings, and always reported.
 *  - Converters produce output that parses: YAML (js-yaml), TypeScript (tsc),
 *    Pydantic v2, RFC 4180 CSV, well-formed XML.
 *  - No inline styles, no alert() for results, no ?. or ??.
 *
 * ES5 syntax only (no arrow functions, let/const, template literals, ?. or ??)
 * so legacy minifiers and server-side editors can parse it.
 */
(function () {
  'use strict';

  var HISTORY_KEY = 'aptdot_json_history';
  var HISTORY_MAX_ITEMS = 5;
  var HISTORY_MAX_CHARS = 100000;     // skip storing very large payloads
  var SHARE_MAX_URL = 8000;           // practical URL length limit
  var FILE_WARN_BYTES = 5 * 1024 * 1024;
  var PROXY_URL = 'https://api.allorigins.win/raw?url=';

  /* ------------------------------------------------------------------ *
   * Small helpers
   * ------------------------------------------------------------------ */

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  /** Message parts: plain strings, or {code: '...'} rendered as <code>. Never HTML. */
  function code(s) { return { code: String(s) }; }
  function msg() { return Array.prototype.slice.call(arguments); }

  function appendMessage(parent, parts) {
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (p && typeof p === 'object' && 'code' in p) {
        parent.appendChild(el('code', '', p.code));
      } else {
        parent.appendChild(document.createTextNode(String(p)));
      }
    }
  }

  function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }

  /* Storage: every call guarded; storage is a convenience, never required. */
  function storageGet(key, fallback) {
    try {
      var raw = window.localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }
  function storageSet(key, value) {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      return false;
    }
  }
  function storageRemove(key) {
    try { window.localStorage.removeItem(key); } catch (e) { /* ignore */ }
  }

  /* Share links: base64url of UTF-8. Decoder also accepts v1 links. */
  function encodeShare(raw) {
    return btoa(unescape(encodeURIComponent(raw)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function decodeShare(s) {
    s = String(s)
      .replace(/ /g, '+')            // v1 links: URLSearchParams turned '+' into ' '
      .replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    return decodeURIComponent(escape(atob(s)));
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.className = 'aptdot-visually-hidden';
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      if (ok) { resolve(); } else { reject(new Error('Copy command failed')); }
    });
  }

  function downloadText(content, fileName, mimeType) {
    var blob = new Blob([content], { type: mimeType + ';charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.className = 'aptdot-visually-hidden';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
  }

  /** Brief feedback on a button, announced via its aria-live sibling. */
  function flashButton(btn, text) {
    if (!btn) return;
    var original = btn.getAttribute('data-label') || btn.textContent;
    btn.setAttribute('data-label', original);
    btn.textContent = text;
    window.setTimeout(function () { btn.textContent = original; }, 1800);
  }

  /* ------------------------------------------------------------------ *
   * Parsing: strict first, string-aware trailing-comma repair second
   * ------------------------------------------------------------------ */

  function removeTrailingCommas(raw) {
    var out = '';
    var inString = false;
    var escaped = false;
    var removed = 0;
    for (var i = 0; i < raw.length; i++) {
      var ch = raw.charAt(i);
      if (inString) {
        out += ch;
        if (escaped) { escaped = false; }
        else if (ch === '\\') { escaped = true; }
        else if (ch === '"') { inString = false; }
        continue;
      }
      if (ch === '"') { inString = true; out += ch; continue; }
      if (ch === ',') {
        var j = i + 1;
        while (j < raw.length && /\s/.test(raw.charAt(j))) j++;
        var next = raw.charAt(j);
        if (next === '}' || next === ']') { removed++; continue; }
      }
      out += ch;
    }
    return { text: out, removed: removed };
  }

  /**
   * Index of the first syntax error in `s`, or -1 if it is valid JSON.
   * Browsers word JSON.parse errors differently and newer ones omit the position,
   * so the validator finds it itself (RFC 8259 grammar).
   */
  function findErrorIndex(s) {
    var i = 0;
    function ws() { while (i < s.length && /[ \t\n\r]/.test(s.charAt(i))) i++; }
    function fail() { throw i; }
    function lit(word) { if (s.substr(i, word.length) !== word) fail(); i += word.length; }
    function str() {
      i++; // opening quote
      while (i < s.length) {
        var c = s.charAt(i);
        if (c === '"') { i++; return; }
        if (c === '\\') {
          var e = s.charAt(i + 1);
          if (e === 'u') { if (!/^[0-9a-fA-F]{4}$/.test(s.substr(i + 2, 4))) { i += 1; fail(); } i += 6; }
          else if ('"\\/bfnrt'.indexOf(e) !== -1 && e !== '') { i += 2; }
          else { i += 1; fail(); }
        } else if (c < ' ') { fail(); }
        else { i++; }
      }
      fail();
    }
    function num() {
      var m = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+\-]?[0-9]+)?/.exec(s.slice(i));
      if (!m) fail();
      i += m[0].length;
    }
    function value() {
      ws();
      var c = s.charAt(i);
      if (c === '{') {
        i++; ws();
        if (s.charAt(i) === '}') { i++; return; }
        for (;;) {
          ws(); if (s.charAt(i) !== '"') fail(); str();
          ws(); if (s.charAt(i) !== ':') fail(); i++;
          value(); ws();
          if (s.charAt(i) === ',') { i++; continue; }
          if (s.charAt(i) === '}') { i++; return; }
          fail();
        }
      } else if (c === '[') {
        i++; ws();
        if (s.charAt(i) === ']') { i++; return; }
        for (;;) {
          value(); ws();
          if (s.charAt(i) === ',') { i++; continue; }
          if (s.charAt(i) === ']') { i++; return; }
          fail();
        }
      } else if (c === '"') { str(); }
      else if (c === 't') { lit('true'); }
      else if (c === 'f') { lit('false'); }
      else if (c === 'n') { lit('null'); }
      else { num(); }
    }
    try {
      value(); ws();
      if (i < s.length) fail();
      return -1;
    } catch (pos) {
      return typeof pos === 'number' ? Math.min(pos, s.length) : -1;
    }
  }

  /** Line, column and the offending line's text for a JSON.parse failure. */
  function errorLocation(raw) {
    var pos = findErrorIndex(raw);
    if (pos < 0) return null;
    var before = raw.slice(0, pos).split('\n');
    var line = before.length;
    return {
      line: line,
      column: before[before.length - 1].length + 1,
      text: raw.split('\n')[line - 1]
    };
  }

  /**
   * Returns {value, repaired, removedCommas} or throws an Error with .location.
   */
  function parseInput(raw) {
    try {
      return { value: JSON.parse(raw), repaired: false, removedCommas: 0 };
    } catch (firstErr) {
      var fix = removeTrailingCommas(raw);
      if (fix.removed > 0) {
        try {
          return { value: JSON.parse(fix.text), repaired: true, removedCommas: fix.removed };
        } catch (e) { /* fall through to original error */ }
      }
      var err = new Error(firstErr.message);
      err.location = errorLocation(raw);
      throw err;
    }
  }

  /* ------------------------------------------------------------------ *
   * Schema.org linter (JSON-LD mode)
   * ------------------------------------------------------------------ */

  // Types whose Google rich results use ratings, and where site-owner reviews are not
  // "self-serving". LocalBusiness / Organization are deliberately excluded.
  var RATING_TYPES = ['Product', 'Recipe', 'SoftwareApplication', 'WebApplication', 'MobileApplication'];

  function typesOf(node) {
    var t = node['@type'];
    if (typeof t === 'string') return [t];
    if (Array.isArray(t)) return t.filter(function (x) { return typeof x === 'string'; });
    return [];
  }

  function lintNode(node, label, report) {
    if (!isPlainObject(node)) return;
    var types = typesOf(node);
    if (types.length === 0 && !node['@id']) {
      report.issues.push(msg(label + ': missing ', code('@type'), '.'));
    }

    if (node.offers) {
      var offers = Array.isArray(node.offers) ? node.offers : [node.offers];
      for (var i = 0; i < offers.length; i++) {
        var offer = offers[i];
        if (!isPlainObject(offer) || typeof offer.availability !== 'string') continue;
        var avail = offer.availability.trim();
        var token = avail.replace(/^https?:\/\/schema\.org\//, '').replace(/^schema\.org\//, '');
        if (/^[A-Za-z]+$/.test(token)) {
          var canonical = 'https://schema.org/' + token;
          if (avail !== canonical) {
            offer.availability = canonical;
            report.fixes.push(msg(label + ' offer ' + (i + 1) + ': ', code('availability'), ' set to ', code(canonical), '.'));
          }
        } else {
          report.warnings.push(msg(label + ' offer ' + (i + 1) + ': unrecognised ', code('availability'), ' value ', code(avail), '.'));
        }
      }
    }

    for (var k = 0; k < types.length; k++) {
      if (RATING_TYPES.indexOf(types[k]) !== -1 && !node.aggregateRating && !node.review) {
        report.warnings.push(msg(
          label + ' (' + types[k] + '): no ', code('aggregateRating'), ' or ', code('review'),
          '. Add one only if real user ratings are shown on the page.'
        ));
        break;
      }
    }
  }

  function lintRoot(root, label, report) {
    if (!isPlainObject(root)) {
      report.issues.push(msg(label + ' is not a JSON object.'));
      return;
    }
    var ctx = root['@context'];
    if (ctx === undefined) {
      root['@context'] = 'https://schema.org';
      report.fixes.push(msg(label + ': added missing ', code('"@context": "https://schema.org"'), '.'));
    } else if (typeof ctx === 'string') {
      var c = ctx.trim();
      if (/^(https?:\/\/)?schema\.org\/?$/.test(c) && c !== 'https://schema.org' && c !== 'https://schema.org/') {
        root['@context'] = 'https://schema.org';
        report.fixes.push(msg(label + ': normalised ', code('@context'), ' from ', code(c), ' to ', code('https://schema.org'), '.'));
      } else if (c !== 'https://schema.org' && c !== 'https://schema.org/') {
        report.warnings.push(msg(label + ': custom ', code('@context'), ' ', code(c), '.'));
      }
    }

    if (Array.isArray(root['@graph'])) {
      for (var i = 0; i < root['@graph'].length; i++) {
        lintNode(root['@graph'][i], label + ' @graph[' + i + ']', report);
      }
    } else {
      lintNode(root, label, report);
    }
  }

  function inspectSchema(parsed) {
    var report = { issues: [], warnings: [], fixes: [] };
    if (Array.isArray(parsed)) {
      for (var i = 0; i < parsed.length; i++) lintRoot(parsed[i], 'Block ' + (i + 1), report);
    } else {
      lintRoot(parsed, 'Root', report);
    }
    return report;
  }

  /* ------------------------------------------------------------------ *
   * Converters
   * ------------------------------------------------------------------ */

  /* --- Shared: merge an array of records into an ordered key list --- */
  function unionKeys(items) {
    var keys = [];
    var seen = {};
    for (var i = 0; i < items.length; i++) {
      if (!isPlainObject(items[i])) continue;
      for (var k in items[i]) {
        if (Object.prototype.hasOwnProperty.call(items[i], k) && !seen[k]) {
          seen[k] = true;
          keys.push(k);
        }
      }
    }
    return keys;
  }

  /* --- CSV (RFC 4180) --- */
  function csvCell(val) {
    if (val === undefined || val === null) return '';
    var s;
    if (typeof val === 'object') {
      s = JSON.stringify(val);
    } else {
      s = String(val);
      // Spreadsheet formula injection guard (strings only, numbers untouched).
      if (typeof val === 'string' && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
    }
    return '"' + s.replace(/"/g, '""') + '"';
  }

  function jsonToCsv(parsed) {
    var items = Array.isArray(parsed) ? parsed : [parsed];
    var objectRows = items.length > 0 && items.every(isPlainObject);
    var lines = [];
    if (!objectRows) {
      lines.push(csvCell('value'));
      for (var i = 0; i < items.length; i++) lines.push(csvCell(items[i]));
      return lines.join('\r\n');
    }
    var headers = unionKeys(items);
    lines.push(headers.map(csvCell).join(','));
    for (var r = 0; r < items.length; r++) {
      var row = items[r];
      lines.push(headers.map(function (h) { return csvCell(row[h]); }).join(','));
    }
    return lines.join('\r\n');
  }

  /* --- Markdown (GFM table) --- */
  function mdCell(val) {
    var text = (val !== null && typeof val === 'object') ? JSON.stringify(val)
      : (val === undefined || val === null ? '' : String(val));
    return text.replace(/\r?\n/g, '<br>').replace(/\|/g, '\\|');
  }

  function jsonToMarkdown(parsed) {
    var items = Array.isArray(parsed) ? parsed : [parsed];
    if (items.length === 0 || !items.every(isPlainObject)) {
      var rows = ['| Value |', '| --- |'];
      for (var i = 0; i < items.length; i++) rows.push('| ' + mdCell(items[i]) + ' |');
      return rows.join('\n');
    }
    var headers = unionKeys(items);
    var md = '| ' + headers.map(mdCell).join(' | ') + ' |\n';
    md += '| ' + headers.map(function () { return '---'; }).join(' | ') + ' |\n';
    for (var r = 0; r < items.length; r++) {
      var row = items[r];
      md += '| ' + headers.map(function (h) { return mdCell(row[h]); }).join(' | ') + ' |\n';
    }
    return md;
  }

  /* --- YAML 1.2 (block style; parses with js-yaml and PyYAML) --- */
  var YAML_RESERVED = /^(true|false|null|yes|no|on|off|y|n|~)$/i;

  function yamlString(s) {
    if (s !== '' && /^[A-Za-z][A-Za-z0-9 _.\/-]*$/.test(s) && !/\s$/.test(s) && !YAML_RESERVED.test(s)) {
      return s;
    }
    return JSON.stringify(s); // JSON strings are valid YAML double-quoted scalars
  }

  function yamlScalar(v) {
    if (v === null) return 'null';
    if (typeof v === 'string') return yamlString(v);
    if (typeof v === 'number') return isFinite(v) ? String(v) : '.nan';
    return String(v);
  }

  function isNonEmptyCollection(v) {
    if (Array.isArray(v)) return v.length > 0;
    return isPlainObject(v) && Object.keys(v).length > 0;
  }

  /** Inline form for scalars and empty collections. */
  function yamlInline(v) {
    if (Array.isArray(v)) return '[]';
    if (isPlainObject(v)) return '{}';
    return yamlScalar(v);
  }

  /** Block form for a non-empty object or array, every line ending in \n. */
  function yamlBlock(v, indent) {
    var pad = new Array(indent + 1).join('  ');
    var out = '';
    var i;
    if (Array.isArray(v)) {
      for (i = 0; i < v.length; i++) {
        var item = v[i];
        if (isPlainObject(item) && isNonEmptyCollection(item)) {
          // Render the mapping one level deeper, then put "- " on its first line.
          out += pad + '- ' + yamlBlock(item, indent + 1).slice(pad.length + 2);
        } else if (isNonEmptyCollection(item)) {
          out += pad + '-\n' + yamlBlock(item, indent + 1);
        } else {
          out += pad + '- ' + yamlInline(item) + '\n';
        }
      }
      return out;
    }
    var keys = Object.keys(v);
    for (i = 0; i < keys.length; i++) {
      var val = v[keys[i]];
      if (isNonEmptyCollection(val)) {
        out += pad + yamlString(keys[i]) + ':\n' + yamlBlock(val, indent + 1);
      } else {
        out += pad + yamlString(keys[i]) + ': ' + yamlInline(val) + '\n';
      }
    }
    return out;
  }

  function jsonToYaml(parsed) {
    if (window.jsyaml && typeof window.jsyaml.dump === 'function') {
      return window.jsyaml.dump(parsed, { lineWidth: -1, noRefs: true });
    }
    return isNonEmptyCollection(parsed) ? yamlBlock(parsed, 0) : yamlInline(parsed) + '\n';
  }

  /* --- Type inference shared by TypeScript and Python --- */
  function pascalCase(s, fallback) {
    var words = String(s).replace(/[^A-Za-z0-9]+/g, ' ').trim().split(/\s+/);
    var name = words.map(function (w) { return w ? w.charAt(0).toUpperCase() + w.slice(1) : ''; }).join('');
    if (!name) name = fallback;
    if (/^[0-9]/.test(name)) name = 'T' + name;
    return name;
  }

  function makeNamer() {
    var used = {};
    return function (base) {
      var name = base;
      var n = 2;
      while (used[name]) { name = base + n; n++; }
      used[name] = true;
      return name;
    };
  }

  /**
   * Builds a shape tree: {kind:'object', fields:[{key, shape, optional}]},
   * {kind:'array', items:[shape]}, {kind:'prim', type:'string'|'number'|'integer'|'boolean'|'null'}.
   * Arrays of objects are merged so every key seen in any element is kept.
   */
  function shapeOf(v) {
    if (v === null) return { kind: 'prim', type: 'null' };
    if (Array.isArray(v)) {
      var objs = v.filter(isPlainObject);
      var others = v.filter(function (x) { return !isPlainObject(x); });
      var items = [];
      if (objs.length) items.push(mergeObjects(objs));
      var seen = {};
      for (var i = 0; i < others.length; i++) {
        var s = shapeOf(others[i]);
        var sig = JSON.stringify(s);
        if (!seen[sig]) { seen[sig] = true; items.push(s); }
      }
      return { kind: 'array', items: items };
    }
    if (isPlainObject(v)) return mergeObjects([v]);
    if (typeof v === 'number') return { kind: 'prim', type: Math.floor(v) === v ? 'integer' : 'number' };
    return { kind: 'prim', type: typeof v };
  }

  function mergeObjects(objs) {
    var keys = unionKeys(objs);
    var fields = keys.map(function (k) {
      var present = objs.filter(function (o) { return Object.prototype.hasOwnProperty.call(o, k); });
      var values = present.map(function (o) { return o[k]; });
      var objVals = values.filter(isPlainObject);
      var shapes = [];
      if (objVals.length) shapes.push(mergeObjects(objVals));
      var seen = {};
      values.filter(function (x) { return !isPlainObject(x); }).forEach(function (x) {
        var s = shapeOf(x);
        var sig = JSON.stringify(s);
        if (!seen[sig]) { seen[sig] = true; shapes.push(s); }
      });
      return { key: k, shapes: shapes, optional: present.length < objs.length };
    });
    return { kind: 'object', fields: fields };
  }

  /* --- TypeScript --- */
  function tsKey(k) {
    return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : JSON.stringify(k);
  }

  function jsonToTypeScript(parsed) {
    var namer = makeNamer();
    var blocks = [];

    function typeFor(shape, hint) {
      if (shape.kind === 'prim') {
        return shape.type === 'integer' ? 'number' : shape.type;
      }
      if (shape.kind === 'array') {
        if (shape.items.length === 0) return 'unknown[]';
        var inner = shape.items.map(function (s) { return typeFor(s, hint + 'Item'); });
        return inner.length === 1 ? inner[0] + '[]' : '(' + inner.join(' | ') + ')[]';
      }
      return emitInterface(shape, hint);
    }

    function unionOf(shapes, hint) {
      if (shapes.length === 0) return 'unknown';
      var seen = {};
      var parts = [];
      shapes.forEach(function (s) {
        var t = typeFor(s, hint);
        if (!seen[t]) { seen[t] = true; parts.push(t); }
      });
      return parts.join(' | ');
    }

    function emitInterface(shape, hint) {
      var name = namer(pascalCase(hint, 'Item'));
      var lines = ['export interface ' + name + ' {'];
      var body = shape.fields.map(function (f) {
        return '  ' + tsKey(f.key) + (f.optional ? '?' : '') + ': ' + unionOf(f.shapes, f.key) + ';';
      });
      blocks.push(lines.concat(body, ['}']).join('\n'));
      return name;
    }

    var root = shapeOf(parsed);
    if (root.kind === 'object') {
      emitInterface(root, 'Root');
    } else {
      var t = typeFor(root, 'Root');
      blocks.push('export type Root = ' + t + ';');
    }
    return blocks.join('\n\n') + '\n';
  }

  /* --- Python (Pydantic v2) --- */
  var PY_KEYWORDS = ('False None True and as assert async await break class continue def del elif else ' +
    'except finally for from global if import in is lambda nonlocal not or pass raise return try ' +
    'while with yield match case type').split(' ');
  // Names that shadow BaseModel attributes and trigger warnings or errors.
  var PY_RESERVED = ('copy dict json schema construct validate fields parse_obj parse_raw parse_file ' +
    'from_orm update_forward_refs schema_json').split(' ');

  function jsonToPython(parsed) {
    var namer = makeNamer();
    var classes = [];
    var needs = { Any: false, List: false, Optional: false, Union: false, Field: false, RootModel: false };

    function pyType(shape, hint) {
      if (shape.kind === 'prim') {
        if (shape.type === 'null') return 'None';
        if (shape.type === 'integer') return 'int';
        if (shape.type === 'number') return 'float';
        if (shape.type === 'boolean') return 'bool';
        return 'str';
      }
      if (shape.kind === 'array') {
        needs.List = true;
        if (shape.items.length === 0) { needs.Any = true; return 'List[Any]'; }
        return 'List[' + unionOf(shape.items, hint + 'Item') + ']';
      }
      return emitClass(shape, hint);
    }

    /** Union of shapes; a null among them makes the result Optional[...]. */
    function unionOf(shapes, hint) {
      if (shapes.length === 0) { needs.Any = true; return 'Any'; }
      var seen = {};
      var parts = [];
      var hasNone = false;
      shapes.forEach(function (s) {
        var t = pyType(s, hint);
        if (t === 'None') { hasNone = true; return; }
        if (!seen[t]) { seen[t] = true; parts.push(t); }
      });
      if (parts.length === 0) { needs.Any = true; return 'Any'; }
      var t = parts[0];
      if (parts.length > 1) { needs.Union = true; t = 'Union[' + parts.join(', ') + ']'; }
      if (hasNone) { needs.Optional = true; t = 'Optional[' + t + ']'; }
      return t;
    }

    function fieldName(key, used) {
      var name = String(key)
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .replace(/[^A-Za-z0-9_]/g, '_')
        .replace(/_+/g, '_')
        .toLowerCase()
        .replace(/_$/, '');
      if (name === '' || /^[0-9_]/.test(name)) name = 'field_' + name.replace(/^_+/, ''); // Pydantic: no leading _
      if (name === 'field_') name = 'field';
      if (PY_KEYWORDS.indexOf(name) !== -1 || PY_RESERVED.indexOf(name) !== -1 || /^model_/.test(name)) name += '_';
      var base = name;
      var n = 2;
      while (used[name]) { name = base + '_' + n; n++; }
      used[name] = true;
      return name;
    }

    function emitClass(shape, hint) {
      var name = namer(pascalCase(hint, 'Model'));
      var used = {};
      var lines = ['class ' + name + '(BaseModel):'];
      var aliased = false;
      if (shape.fields.length === 0) lines.push('    pass');
      shape.fields.forEach(function (f) {
        var py = fieldName(f.key, used);
        var t = unionOf(f.shapes, f.key);
        needs.Optional = true;
        if (py !== f.key) {
          aliased = true;
          needs.Field = true;
          lines.push('    ' + py + ': Optional[' + t + '] = Field(default=None, alias=' + JSON.stringify(f.key) + ')');
        } else {
          lines.push('    ' + py + ': Optional[' + t + '] = None');
        }
      });
      if (aliased) {
        lines.push('');
        lines.push('    model_config = ConfigDict(populate_by_name=True)');
      }
      classes.push(lines.join('\n'));
      return name;
    }

    var root = shapeOf(parsed);
    var tail = '';
    if (root.kind === 'object') {
      emitClass(root, 'AutoGeneratedModel');
    } else {
      needs.RootModel = true;
      tail = '\n\n\nclass AutoGeneratedRoot(RootModel[' + pyType(root, 'AutoGenerated') + ']):\n    pass';
    }

    var typing = ['Any', 'List', 'Optional', 'Union'].filter(function (n) { return needs[n]; });
    var header = typing.length ? 'from typing import ' + typing.join(', ') + '\n' : '';
    var pyd = ['BaseModel'];
    if (needs.Field) pyd.push('ConfigDict', 'Field');
    if (needs.RootModel) pyd.push('RootModel');
    header += 'from pydantic import ' + pyd.join(', ') + '\n\n\n';
    return header + classes.join('\n\n\n') + tail + '\n';
  }

  /* --- XML --- */
  function xmlName(key) {
    var name = String(key).replace(/^@/, '').replace(/[^A-Za-z0-9_.\-]/g, '_');
    if (name === '' || /^[0-9.\-]/.test(name) || /^xml/i.test(name)) name = '_' + name;
    return name;
  }

  function xmlText(v) {
    return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function xmlNode(v, name, indent) {
    var pad = new Array(indent + 1).join('  ');
    if (Array.isArray(v)) {
      return v.map(function (item) { return xmlNode(item, name, indent); }).join('');
    }
    if (isPlainObject(v)) {
      var keys = Object.keys(v);
      if (keys.length === 0) return pad + '<' + name + '/>\n';
      var inner = keys.map(function (k) {
        var child = v[k];
        if (Array.isArray(child) && child.length === 0) return pad + '  <' + xmlName(k) + '/>\n';
        return xmlNode(child, xmlName(k), indent + 1);
      }).join('');
      return pad + '<' + name + '>\n' + inner + pad + '</' + name + '>\n';
    }
    if (v === null) return pad + '<' + name + '/>\n';
    return pad + '<' + name + '>' + xmlText(v) + '</' + name + '>\n';
  }

  function jsonToXml(parsed) {
    var body = Array.isArray(parsed)
      ? '<root>\n' + xmlNode(parsed, 'item', 1) + '</root>\n'
      : xmlNode(isPlainObject(parsed) ? parsed : { value: parsed }, 'root', 0);
    return '<?xml version="1.0" encoding="UTF-8"?>\n' + body;
  }

  /* ------------------------------------------------------------------ *
   * Workbench
   * ------------------------------------------------------------------ */

  function initAptdotJsonSuite() {
    var jsonInput = document.getElementById('jsonInput');
    var jsonOutput = document.getElementById('jsonOutput');
    var inputGutter = document.getElementById('inputGutter');
    var modeSelect = document.getElementById('modeSelect');
    var mockSelect = document.getElementById('mockSelect');
    var historySelect = document.getElementById('historySelect');
    var fileInput = document.getElementById('jsonFileInput');
    var fetchUrlBtn = document.getElementById('fetchUrlBtn');
    var shareUrlBtn = document.getElementById('shareUrlBtn');
    var editorDropZone = document.getElementById('editorDropZone');

    if (!jsonInput || !jsonOutput) return;

    /* --- Gutter --- */
    function updateGutter() {
      if (!inputGutter) return;
      var lines = (jsonInput.value.match(/\n/g) || []).length + 1;
      var html = '';
      for (var i = 1; i <= lines; i++) html += '<span>' + i + '</span>'; // numbers only
      inputGutter.innerHTML = html;
    }
    function setInput(text) {
      jsonInput.value = text;
      updateGutter();
    }
    jsonInput.addEventListener('input', updateGutter);
    jsonInput.addEventListener('scroll', function () {
      if (inputGutter) inputGutter.scrollTop = jsonInput.scrollTop;
    });

    /* --- Output panel --- */
    function clearOutput() {
      while (jsonOutput.firstChild) jsonOutput.removeChild(jsonOutput.firstChild);
    }

    function showNotice(kind, parts, tip) {
      clearOutput();
      var box = el('div', 'aptdot-report-box aptdot-report-' + kind);
      box.setAttribute('role', kind === 'error' ? 'alert' : 'status');
      var p = el('p', 'aptdot-report-line');
      appendMessage(p, parts);
      box.appendChild(p);
      if (tip) box.appendChild(el('p', 'aptdot-report-tip', tip));
      jsonOutput.appendChild(box);
    }

    function buildHeader(title, content, fileName, mimeType) {
      var header = el('div', 'aptdot-panel-header');
      header.appendChild(el('span', 'aptdot-panel-title', title));
      var actions = el('div', 'aptdot-panel-actions');
      var copyBtn = el('button', 'aptdot-tool-btn aptdot-tool-btn-sm', 'Copy');
      copyBtn.type = 'button';
      copyBtn.addEventListener('click', function () {
        copyText(content).then(function () { flashButton(copyBtn, 'Copied'); },
          function () { flashButton(copyBtn, 'Copy failed'); });
      });
      var dlBtn = el('button', 'aptdot-tool-btn aptdot-tool-btn-sm', 'Download ' + fileName.replace(/^[^.]*/, ''));
      dlBtn.type = 'button';
      dlBtn.addEventListener('click', function () { downloadText(content, fileName, mimeType); });
      actions.appendChild(copyBtn);
      actions.appendChild(dlBtn);
      header.appendChild(actions);
      return header;
    }

    function buildReport(report) {
      var groups = [
        ['fixes', 'Auto-fixes applied'],
        ['warnings', 'Recommendations'],
        ['issues', 'Issues']
      ];
      var box = null;
      for (var g = 0; g < groups.length; g++) {
        var list = report[groups[g][0]];
        if (!list || list.length === 0) continue;
        if (!box) box = el('div', 'aptdot-report-box');
        var section = el('div', 'aptdot-report-' + groups[g][0]);
        section.appendChild(el('strong', '', groups[g][1] + ' (' + list.length + ')'));
        var ul = el('ul', 'aptdot-report-list');
        for (var i = 0; i < list.length; i++) {
          var li = el('li');
          appendMessage(li, list[i]);
          ul.appendChild(li);
        }
        section.appendChild(ul);
        box.appendChild(section);
      }
      return box;
    }

    /* Escapes &, < and > first (enough for element content), then wraps tokens. */
    function highlightJsonLine(line) {
      var safe = String(line).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      return safe.replace(
        /("(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+\-]?\d+)?)/g,
        function (match) {
          var cls = 'token-number';
          if (/^"/.test(match)) cls = /:$/.test(match) ? 'token-key' : 'token-string';
          else if (match === 'true' || match === 'false') cls = 'token-boolean';
          else if (match === 'null') cls = 'token-null';
          return '<span class="' + cls + '">' + match + '</span>';
        }
      );
    }

    /** Renders numbered lines. `highlight` = true for JSON; content is always escaped. */
    function renderLines(text, highlight) {
      var table = el('table', 'aptdot-output-table');
      var tbody = el('tbody');
      var lines = text.split('\n');
      for (var i = 0; i < lines.length; i++) {
        var tr = el('tr', 'aptdot-output-row');
        tr.appendChild(el('td', 'aptdot-output-num', i + 1));
        var td = el('td', 'aptdot-output-text');
        if (highlight) td.innerHTML = highlightJsonLine(lines[i]); // escaped first
        else td.textContent = lines[i];
        tr.appendChild(td);
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      return table;
    }

    function renderResult(opts) {
      clearOutput();
      jsonOutput.appendChild(buildHeader(opts.title, opts.content, opts.fileName, opts.mimeType));
      if (opts.report) {
        var box = buildReport(opts.report);
        if (box) jsonOutput.appendChild(box);
      }
      jsonOutput.appendChild(renderLines(opts.content, !!opts.highlight));
    }

    /* --- History (optional; silently off when storage is blocked) --- */
    function refreshHistoryDropdown() {
      if (!historySelect) return;
      var history = storageGet(HISTORY_KEY, []);
      if (!Array.isArray(history)) history = [];
      while (historySelect.firstChild) historySelect.removeChild(historySelect.firstChild);
      var head = el('option', '', 'Recent history (' + history.length + ')');
      head.value = '';
      head.disabled = true;
      head.selected = true;
      historySelect.appendChild(head);
      for (var i = 0; i < history.length; i++) {
        var opt = el('option', '', history[i] && history[i].label);
        opt.value = String(i);
        historySelect.appendChild(opt);
      }
      if (history.length) {
        var clear = el('option', '', 'Clear history');
        clear.value = '__clear';
        historySelect.appendChild(clear);
      }
    }

    function saveToHistory(raw) {
      if (!raw || raw.length < 5 || raw.length > HISTORY_MAX_CHARS) return;
      var history = storageGet(HISTORY_KEY, []);
      if (!Array.isArray(history)) history = [];
      history = history.filter(function (item) { return item && item.data !== raw; });
      history.unshift({
        label: new Date().toLocaleTimeString() + ' - ' + raw.substring(0, 35).replace(/\s+/g, ' ') + '...',
        data: raw
      });
      if (history.length > HISTORY_MAX_ITEMS) history.length = HISTORY_MAX_ITEMS;
      storageSet(HISTORY_KEY, history);
      refreshHistoryDropdown();
    }

    refreshHistoryDropdown();
    if (historySelect) {
      historySelect.addEventListener('change', function () {
        if (this.value === '__clear') {
          storageRemove(HISTORY_KEY);
          refreshHistoryDropdown();
          return;
        }
        var history = storageGet(HISTORY_KEY, []);
        var item = Array.isArray(history) ? history[parseInt(this.value, 10)] : null;
        if (item && typeof item.data === 'string') setInput(item.data);
      });
    }

    /* --- Shared link hydration (?data=) --- */
    try {
      var params = new URLSearchParams(window.location.search);
      if (params.has('data')) setInput(decodeShare(params.get('data')));
    } catch (e) {
      showNotice('error', msg('This shared link could not be decoded. It may have been cut short when it was copied.'));
    }

    /* --- Actions --- */
    var ACTIONS = {
      minify: function (p) { return { title: 'Minified JSON', content: JSON.stringify(p), fileName: 'minified.json', mimeType: 'application/json' }; },
      csv: function (p) { return { title: 'CSV (RFC 4180)', content: jsonToCsv(p), fileName: 'converted.csv', mimeType: 'text/csv' }; },
      ts: function (p) { return { title: 'TypeScript interfaces', content: jsonToTypeScript(p), fileName: 'types.ts', mimeType: 'text/plain' }; },
      yaml: function (p) { return { title: 'YAML', content: jsonToYaml(p), fileName: 'converted.yaml', mimeType: 'application/yaml' }; },
      xml: function (p) { return { title: 'XML', content: jsonToXml(p), fileName: 'converted.xml', mimeType: 'application/xml' }; },
      python: function (p) { return { title: 'Pydantic v2 models', content: jsonToPython(p), fileName: 'models.py', mimeType: 'text/x-python' }; },
      md: function (p) { return { title: 'Markdown table', content: jsonToMarkdown(p), fileName: 'table.md', mimeType: 'text/markdown' }; }
    };

    function runAction(action) {
      var raw = jsonInput.value.trim();

      if (action === 'clear') {
        setInput('');
        clearOutput();
        jsonOutput.appendChild(el('div', 'aptdot-placeholder-text', 'Output will appear here after you choose an action.'));
        return;
      }
      if (!raw) {
        showNotice('info', msg('Paste JSON, upload a file or load a sample first.'));
        return;
      }
      if (action === 'base64') {
        var b64 = btoa(unescape(encodeURIComponent(raw)));
        renderResult({ title: 'Base64 (UTF-8)', content: b64, fileName: 'encoded.txt', mimeType: 'text/plain' });
        return;
      }

      var result;
      try {
        result = parseInput(raw);
      } catch (err) {
        var loc = err.location;
        var parts = loc
          ? msg('Invalid JSON at line ' + loc.line + ', column ' + loc.column + ': ', code(loc.text.slice(0, 200)))
          : msg('Invalid JSON: ' + err.message);
        showNotice('error', parts,
          'Input must be JSON starting with { or [. CSV, YAML and plain text cannot be parsed.');
        return;
      }

      var parsed = result.value;
      var report = { issues: [], warnings: [], fixes: [] };
      if (result.repaired) {
        report.fixes.push(msg('Removed ' + result.removedCommas + ' trailing comma(s). Your input was not valid JSON (RFC 8259).'));
      }

      if (action === 'validate' || action === 'format') {
        var jsonld = modeSelect && modeSelect.value === 'jsonld';
        if (jsonld) {
          var lint = inspectSchema(parsed);
          report.fixes = report.fixes.concat(lint.fixes);
          report.warnings = lint.warnings;
          report.issues = lint.issues;
        }
        var pretty = JSON.stringify(parsed, null, 2);
        var title = jsonld
          ? (report.issues.length ? 'Validated with issues' : 'Valid JSON-LD')
          : (result.repaired ? 'Formatted (repaired)' : 'Valid JSON');
        renderResult({
          title: title, content: pretty, fileName: jsonld ? 'schema.jsonld' : 'formatted.json',
          mimeType: jsonld ? 'application/ld+json' : 'application/json', report: report, highlight: true
        });
        saveToHistory(raw);
        return;
      }

      var handler = ACTIONS[action];
      if (!handler) return;
      var out;
      try {
        out = handler(parsed);
      } catch (convErr) {
        showNotice('error', msg('Conversion failed: ' + convErr.message));
        return;
      }
      out.report = report;
      renderResult(out);
      saveToHistory(raw);
    }

    document.addEventListener('click', function (e) {
      var target = e.target;
      var btn = target && target.closest ? target.closest('.aptdot-tool-btn[data-workbench-action]') : null;
      if (!btn) return;
      e.preventDefault();
      runAction(btn.getAttribute('data-workbench-action'));
    });

    /* Optional: run the page's default action once on load if input is present. */
    var wrapper = jsonInput.closest ? jsonInput.closest('[data-default-action]') : null;
    if (wrapper && jsonInput.value.trim()) runAction(wrapper.getAttribute('data-default-action'));

    /* --- Fetch from URL (third-party proxy only with consent) --- */
    if (fetchUrlBtn) {
      fetchUrlBtn.addEventListener('click', function () {
        var url = window.prompt('Enter a public JSON URL (https://...):');
        if (!url) return;
        if (!/^https?:\/\//i.test(url)) {
          showNotice('error', msg('Enter a full URL starting with https://'));
          return;
        }
        showNotice('info', msg('Fetching...'));

        function load(target) {
          return fetch(target, { credentials: 'omit' }).then(function (res) {
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return res.text();
          });
        }

        load(url).then(null, function (directErr) {
          var ok = window.confirm(
            'This site blocks direct browser requests (CORS).\n\n' +
            'Retry through the public proxy allorigins.win? The URL will be sent to that third-party service.'
          );
          if (!ok) throw directErr;
          return load(PROXY_URL + encodeURIComponent(url));
        }).then(function (text) {
          setInput(text);
          clearOutput();
        }, function (err) {
          showNotice('error', msg('Could not fetch the URL: ' + err.message));
        });
      });
    }

    /* --- Share link --- */
    if (shareUrlBtn) {
      shareUrlBtn.addEventListener('click', function () {
        var raw = jsonInput.value.trim();
        if (!raw) {
          showNotice('info', msg('Enter some JSON to create a share link.'));
          return;
        }
        var link;
        try {
          link = window.location.origin + window.location.pathname + '?data=' + encodeShare(raw);
        } catch (e) {
          showNotice('error', msg('This input could not be encoded for a link.'));
          return;
        }
        if (link.length > SHARE_MAX_URL) {
          showNotice('info', msg('This input is too large for a share link (' + link.length + ' characters). Download the file instead.'));
          return;
        }
        copyText(link).then(function () { flashButton(shareUrlBtn, 'Link copied'); },
          function () { showNotice('info', msg('Copy this link: ', code(link))); });
      });
    }

    /* --- Mock presets --- */
    var MOCKS = {
      users: [
        { id: 1, name: 'Alice Johnson', role: 'Frontend Dev', active: true },
        { id: 2, name: 'Bob Smith', role: 'Backend Engineer', active: false }
      ],
      products: [
        { sku: 'PROD-101', title: 'Wireless Mouse', price: 29.99, stock: 120 },
        { sku: 'PROD-102', title: 'Mechanical Keyboard', price: 89.5, stock: 45 }
      ],
      geo: { city: 'Chandigarh', lat: 30.7333, lng: 76.7794, timezone: 'Asia/Kolkata' }
    };
    if (mockSelect) {
      mockSelect.addEventListener('change', function () {
        if (MOCKS[this.value]) setInput(JSON.stringify(MOCKS[this.value], null, 2));
        this.value = '';
      });
    }

    /* --- File upload and drag-and-drop --- */
    function readFile(file) {
      if (!file) return;
      var name = file.name.toLowerCase();
      var notes = [];
      if (!/\.(json|jsonld|txt)$/.test(name)) {
        notes.push('"' + file.name + '" is not a .json file. It will only work if it contains JSON.');
      }
      if (file.size > FILE_WARN_BYTES) {
        notes.push('This file is ' + Math.round(file.size / 1048576) + ' MB; the editor may be slow.');
      }
      var reader = new FileReader();
      reader.onload = function (ev) {
        setInput(String(ev.target.result));
        if (notes.length) showNotice('info', msg(notes.join(' ')));
        else clearOutput();
      };
      reader.onerror = function () { showNotice('error', msg('The file could not be read.')); };
      reader.readAsText(file);
    }

    if (fileInput) {
      fileInput.addEventListener('change', function () {
        if (this.files && this.files[0]) readFile(this.files[0]);
        this.value = '';
      });
    }

    if (editorDropZone) {
      var over = function (e) {
        e.preventDefault();
        e.stopPropagation();
        editorDropZone.classList.add('aptdot-drag-over');
      };
      var leave = function (e) {
        e.preventDefault();
        e.stopPropagation();
        editorDropZone.classList.remove('aptdot-drag-over');
      };
      editorDropZone.addEventListener('dragenter', over, false);
      editorDropZone.addEventListener('dragover', over, false);
      editorDropZone.addEventListener('dragleave', leave, false);
      editorDropZone.addEventListener('drop', function (e) {
        leave(e);
        var files = e.dataTransfer && e.dataTransfer.files;
        if (files && files[0]) readFile(files[0]);
      }, false);
    }
  }

  // Exposed for automated tests only; not used by the page.
  window.AptdotJsonSuite = {
    parseInput: parseInput, inspectSchema: inspectSchema, jsonToCsv: jsonToCsv,
    jsonToMarkdown: jsonToMarkdown, jsonToYaml: jsonToYaml, jsonToTypeScript: jsonToTypeScript,
    jsonToPython: jsonToPython, jsonToXml: jsonToXml, encodeShare: encodeShare, decodeShare: decodeShare
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAptdotJsonSuite);
  } else {
    initAptdotJsonSuite();
  }
})();
