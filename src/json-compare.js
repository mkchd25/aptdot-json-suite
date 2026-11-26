/*!
 * Aptdot JSON Compare v1.0.0
 * https://www.aptdot.com/tools/json-compare/
 * MIT License (c) 2026 Aptdot. Source: https://github.com/mkchd25/aptdot-json-suite
 *
 * Runs entirely in the browser: no network requests, nothing stored.
 * Uses its own JSON reader instead of JSON.parse, so that:
 *  - numbers are compared exactly at any size (12345678901234567890 and
 *    12345678901234567891 are different), and 1, 1.0 and 1e0 can count as equal;
 *  - every value keeps its line number for the side-by-side view;
 *  - duplicate keys, comments and trailing commas are reported instead of lost.
 * Differences are listed with their paths and can be exported as JSON Patch
 * (RFC 6902) that turns the left JSON into the right JSON.
 */
(function () {
  'use strict';

  var MAX_DEPTH = 1000;
  var AUTO_LIMIT = 1024 * 1024;   // compare while typing below 1 MB (both sides)
  var MAX_LCS_CELLS = 4000000;    // work budget (x5) before long lists are compared by position
  var MAX_LIST = 500;             // changes shown in the list
  var MAX_VIEW_LINES = 5000;      // lines shown per side in the side-by-side view

  var DEFAULTS = {
    arrays: 'smart',        // 'smart' | 'position' | 'unordered' | 'key'
    arrayKey: 'id',         // field used when arrays = 'key'
    ignoreKeys: '',         // comma-separated key names to ignore anywhere
    numbersByValue: true,   // 1, 1.0 and 1e0 are equal
    nullEqualsMissing: false // a key set to null counts the same as a missing key
  };

  function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

  /* =====================================================================
   * 1. JSON reader with exact numbers and positions
   * ===================================================================== */
  function ParseError(message, pos, src) {
    var lc = lineCol(src, pos);
    this.message = message;
    this.line = lc.line;
    this.col = lc.col;
  }

  function lineCol(src, pos) {
    var line = 1, col = 1;
    for (var i = 0; i < pos && i < src.length; i++) {
      if (src.charCodeAt(i) === 10) { line++; col = 1; } else col++;
    }
    return { line: line, col: col };
  }

  function describeChar(ch) {
    if (ch === undefined || ch === '') return 'the end of the text';
    if (ch === '\n') return 'a line break';
    if (ch === '\t') return 'a tab';
    if (ch === "'") return "a single quote (JSON needs double quotes)";
    return '"' + ch + '"';
  }

  // opts.jsonc: allow // and /* */ comments and trailing commas (reported as notes)
  function parse(text, opts) {
    opts = opts || {};
    var src = String(text == null ? '' : text);
    if (src.charCodeAt(0) === 0xFEFF) src = src.slice(1);
    var i = 0;
    var n = src.length;
    var line = 1;
    var lineStart = 0;
    var notes = { comments: 0, trailingCommas: 0, duplicates: [] };

    function fail(msg, at) { throw new ParseError(msg, at === undefined ? i : at, src); }

    function skip() {
      for (;;) {
        while (i < n) {
          var c = src.charCodeAt(i);
          if (c === 32 || c === 9 || c === 13) i++;
          else if (c === 10) { i++; line++; lineStart = i; }
          else break;
        }
        if (src.charAt(i) === '/' && (src.charAt(i + 1) === '/' || src.charAt(i + 1) === '*')) {
          if (!opts.jsonc) fail('Comments are not allowed in JSON');
          notes.comments++;
          if (src.charAt(i + 1) === '/') {
            while (i < n && src.charCodeAt(i) !== 10) i++;
          } else {
            var end = src.indexOf('*/', i + 2);
            if (end === -1) fail('This comment is never closed with */');
            for (var k = i; k < end; k++) if (src.charCodeAt(k) === 10) { line++; lineStart = k + 1; }
            i = end + 2;
          }
          continue;
        }
        return;
      }
    }

    function value(depth) {
      if (depth > MAX_DEPTH) fail('This JSON is nested more than ' + MAX_DEPTH + ' levels deep');
      skip();
      var startLine = line;
      var c = src.charAt(i);
      var node;
      if (c === '{') node = object(depth);
      else if (c === '[') node = array(depth);
      else if (c === '"') node = { t: 'str', v: string() };
      else if (c === '-' || (c >= '0' && c <= '9')) node = number();
      else if (src.substr(i, 4) === 'true') { i += 4; node = { t: 'bool', v: true }; }
      else if (src.substr(i, 5) === 'false') { i += 5; node = { t: 'bool', v: false }; }
      else if (src.substr(i, 4) === 'null') { i += 4; node = { t: 'null' }; }
      else fail('Expected a value but found ' + describeChar(c));
      node.l1 = startLine;
      node.l2 = line;
      return node;
    }

    function object(depth) {
      var node = { t: 'obj', keys: [], vals: [], idx: Object.create(null) };
      i++;
      skip();
      if (src.charAt(i) === '}') { i++; return node; }
      for (;;) {
        skip();
        if (src.charAt(i) !== '"') {
          if (src.charAt(i) === '}' && opts.jsonc && node.keys.length) { notes.trailingCommas++; i++; return node; }
          fail('Expected a key in double quotes but found ' + describeChar(src.charAt(i)));
        }
        var keyLine = line;
        var key = string();
        skip();
        if (src.charAt(i) !== ':') fail('Expected ":" after the key "' + key + '" but found ' + describeChar(src.charAt(i)));
        i++;
        var val = value(depth + 1);
        val.kl = keyLine;
        if (node.idx[key] !== undefined) {
          notes.duplicates.push({ key: key, line: keyLine });
          node.vals[node.idx[key]] = val;   // the last value wins, as with JSON.parse
        } else {
          node.idx[key] = node.keys.length;
          node.keys.push(key);
          node.vals.push(val);
        }
        skip();
        var c = src.charAt(i);
        if (c === ',') { i++; continue; }
        if (c === '}') { i++; return node; }
        if (c === '"') fail('A comma is missing before this key');
        fail('Expected "," or "}" but found ' + describeChar(c));
      }
    }

    function array(depth) {
      var node = { t: 'arr', items: [] };
      i++;
      skip();
      if (src.charAt(i) === ']') { i++; return node; }
      for (;;) {
        skip();
        if (src.charAt(i) === ']' && opts.jsonc && node.items.length) { notes.trailingCommas++; i++; return node; }
        node.items.push(value(depth + 1));
        skip();
        var c = src.charAt(i);
        if (c === ',') { i++; continue; }
        if (c === ']') { i++; return node; }
        if (/^["\-0-9{\[tfn]$/.test(c)) fail('A comma is missing before this item');
        fail('Expected "," or "]" but found ' + describeChar(c));
      }
    }

    function string() {
      var start = i;
      i++;
      var out = '';
      var chunk = i;
      for (;;) {
        if (i >= n) fail('This text is never closed with a double quote', start);
        var c = src.charCodeAt(i);
        if (c === 34) { out += src.slice(chunk, i); i++; return out; }
        if (c < 32) fail(c === 10 ? 'A line break is not allowed inside a JSON string (write \\n instead)' : 'A control character is not allowed inside a JSON string');
        if (c === 92) {
          out += src.slice(chunk, i);
          var e = src.charAt(i + 1);
          if (e === '"' || e === '\\' || e === '/') out += e;
          else if (e === 'b') out += '\b';
          else if (e === 'f') out += '\f';
          else if (e === 'n') out += '\n';
          else if (e === 'r') out += '\r';
          else if (e === 't') out += '\t';
          else if (e === 'u') {
            var hex = src.substr(i + 2, 4);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail('\\u must be followed by four hexadecimal digits', i);
            out += String.fromCharCode(parseInt(hex, 16));
            i += 4;
          } else fail('Unknown escape \\' + e, i);
          i += 2;
          chunk = i;
          continue;
        }
        i++;
      }
    }

    function number() {
      var start = i;
      if (src.charAt(i) === '-') i++;
      if (src.charAt(i) === '0') {
        i++;
        if (src.charAt(i) >= '0' && src.charAt(i) <= '9') fail('Numbers cannot start with 0 in JSON (write it as text: "0' + src.charAt(i) + '...")', start);
      } else if (src.charAt(i) >= '1' && src.charAt(i) <= '9') {
        while (src.charAt(i) >= '0' && src.charAt(i) <= '9') i++;
      } else fail('Expected a digit after "-"');
      if (src.charAt(i) === '.') {
        i++;
        if (!(src.charAt(i) >= '0' && src.charAt(i) <= '9')) fail('Expected a digit after the decimal point');
        while (src.charAt(i) >= '0' && src.charAt(i) <= '9') i++;
      }
      if (src.charAt(i) === 'e' || src.charAt(i) === 'E') {
        i++;
        if (src.charAt(i) === '+' || src.charAt(i) === '-') i++;
        if (!(src.charAt(i) >= '0' && src.charAt(i) <= '9')) fail('Expected a digit in the exponent');
        while (src.charAt(i) >= '0' && src.charAt(i) <= '9') i++;
      }
      var raw = src.slice(start, i);
      return { t: 'num', raw: raw, canon: canonNumber(raw) };
    }

    try {
      skip();
      if (i >= n) return { ok: false, error: { message: 'This side is empty', line: 1, col: 1 } };
      var root = value(0);
      skip();
      if (i < n) fail('Unexpected ' + describeChar(src.charAt(i)) + ' after the end of the JSON');
      return { ok: true, value: root, notes: notes };
    } catch (e) {
      if (e instanceof ParseError) return { ok: false, error: { message: e.message, line: e.line, col: e.col } };
      if (e instanceof RangeError) return { ok: false, error: { message: 'This JSON is nested too deeply', line: 1, col: 1 } };
      throw e;
    }
  }

  // Exact numeric identity: "1", "1.0", "1e0" and "10E-1" all give "1e0".
  function canonNumber(raw) {
    var m = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+\-]?\d+))?$/.exec(raw);
    var sign = m[1];
    var digits = m[2] + (m[3] || '');
    var exp = parseInt(m[4] || '0', 10) - (m[3] ? m[3].length : 0);
    var lead = 0;
    while (lead < digits.length - 1 && digits.charAt(lead) === '0') lead++;
    digits = digits.slice(lead);
    if (/^0+$/.test(digits)) return '0';
    var trail = digits.length;
    while (trail > 1 && digits.charAt(trail - 1) === '0') trail--;
    exp += digits.length - trail;
    digits = digits.slice(0, trail);
    return sign + digits + 'e' + exp;
  }

  /* =====================================================================
   * 2. Writing values back as JSON (exact numbers, original key order)
   * ===================================================================== */
  function repeat(s, k) { var o = ''; for (var x = 0; x < k; x++) o += s; return o; }

  function toJson(node, indent, depth) {
    depth = depth || 0;
    switch (node.t) {
      case 'str': return JSON.stringify(node.v);
      case 'num': return node.raw;
      case 'bool': return node.v ? 'true' : 'false';
      case 'null': return 'null';
    }
    var pad = indent ? repeat(indent, depth + 1) : '';
    var end = indent ? '\n' + repeat(indent, depth) : '';
    var sep = indent ? ',\n' : ',';
    var parts = [];
    var k;
    if (node.t === 'arr') {
      if (!node.items.length) return '[]';
      for (k = 0; k < node.items.length; k++) parts.push(pad + toJson(node.items[k], indent, depth + 1));
      return '[' + (indent ? '\n' : '') + parts.join(sep) + end + ']';
    }
    if (!node.keys.length) return '{}';
    for (k = 0; k < node.keys.length; k++) {
      parts.push(pad + JSON.stringify(node.keys[k]) + (indent ? ': ' : ':') + toJson(node.vals[k], indent, depth + 1));
    }
    return '{' + (indent ? '\n' : '') + parts.join(sep) + end + '}';
  }

  /* =====================================================================
   * 3. Comparing
   * ===================================================================== */
  function parseIgnore(list) {
    var set = Object.create(null);
    var count = 0;
    String(list || '').split(/[,\n]/).forEach(function (s) {
      s = s.replace(/^\s+|\s+$/g, '');
      if (s) { set[s] = true; count++; }
    });
    return { set: set, count: count };
  }

  // A text fingerprint of a value under the comparison rules, used to find equal items.
  function fingerprint(node, ctx) {
    if (node.fp !== undefined && node.fpFor === ctx.id) return node.fp;
    var out;
    switch (node.t) {
      case 'str': out = 's' + JSON.stringify(node.v); break;
      case 'num': out = 'n' + (ctx.numbersByValue ? node.canon : node.raw); break;
      case 'bool': out = node.v ? 'T' : 'F'; break;
      case 'null': out = 'N'; break;
      case 'arr':
        var items = [];
        for (var a = 0; a < node.items.length; a++) items.push(fingerprint(node.items[a], ctx));
        if (ctx.arrays === 'unordered') items.sort();
        out = '[' + items.join(',') + ']';
        break;
      default:
        var pairs = [];
        for (var k = 0; k < node.keys.length; k++) {
          if (ctx.ignore[node.keys[k]]) continue;
          if (ctx.nullMissing && node.vals[k].t === 'null') continue;
          pairs.push(JSON.stringify(node.keys[k]) + ':' + fingerprint(node.vals[k], ctx));
        }
        pairs.sort();
        out = '{' + pairs.join(',') + '}';
    }
    node.fp = out;
    node.fpFor = ctx.id;
    return out;
  }

  var ctxCounter = 0;

  function Differ(opts) {
    this.ctx = {
      id: ++ctxCounter,
      arrays: opts.arrays,
      numbersByValue: opts.numbersByValue !== false,
      nullMissing: !!opts.nullEqualsMissing,
      ignore: parseIgnore(opts.ignoreKeys).set
    };
    this.arrayKey = String(opts.arrayKey || '').replace(/^\s+|\s+$/g, '');
    this.changes = [];
    this.notes = { lcsFallback: 0, keyFallback: 0, keyFallbackPaths: [], numberFormat: 0, ignored: 0, nullMissing: 0 };
  }

  Differ.prototype.equal = function (a, b) {
    return fingerprint(a, this.ctx) === fingerprint(b, this.ctx);
  };

  Differ.prototype.add = function (kind, lpath, rpath, left, right) {
    this.changes.push({ kind: kind, lpath: lpath, rpath: rpath, left: left, right: right });
  };

  Differ.prototype.diff = function (a, b, lpath, rpath) {
    if (a.t !== b.t) {
      this.add('type', lpath, rpath, a, b);
      return;
    }
    switch (a.t) {
      case 'str': if (a.v !== b.v) this.add('changed', lpath, rpath, a, b); return;
      case 'bool': if (a.v !== b.v) this.add('changed', lpath, rpath, a, b); return;
      case 'null': return;
      case 'num':
        if (this.ctx.numbersByValue) {
          if (a.canon !== b.canon) this.add('changed', lpath, rpath, a, b);
          else if (a.raw !== b.raw) this.notes.numberFormat++;
        } else if (a.raw !== b.raw) this.add('changed', lpath, rpath, a, b);
        return;
      case 'obj': this.diffObject(a, b, lpath, rpath); return;
      case 'arr': this.diffArray(a, b, lpath, rpath); return;
    }
  };

  Differ.prototype.diffObject = function (a, b, lpath, rpath) {
    var k, key;
    for (k = 0; k < a.keys.length; k++) {
      key = a.keys[k];
      if (this.ctx.ignore[key]) { this.notes.ignored++; continue; }
      if (b.idx[key] === undefined) {
        if (this.ctx.nullMissing && a.vals[k].t === 'null') { this.notes.nullMissing++; continue; }
        this.add('removed', lpath.concat([key]), null, a.vals[k], null);
      }
      else this.diff(a.vals[k], b.vals[b.idx[key]], lpath.concat([key]), rpath.concat([key]));
    }
    for (k = 0; k < b.keys.length; k++) {
      key = b.keys[k];
      if (this.ctx.ignore[key]) { if (a.idx[key] === undefined) this.notes.ignored++; continue; }
      if (a.idx[key] === undefined) {
        if (this.ctx.nullMissing && b.vals[k].t === 'null') { this.notes.nullMissing++; continue; }
        this.add('added', null, rpath.concat([key]), null, b.vals[k]);
      }
    }
  };

  Differ.prototype.diffArray = function (a, b, lpath, rpath) {
    var mode = this.ctx.arrays;
    if (mode === 'key') {
      if (this.diffByKey(a, b, lpath, rpath)) return;
      this.notes.keyFallback++;
      if (this.notes.keyFallbackPaths.length < 3) this.notes.keyFallbackPaths.push(readablePath(lpath));
      mode = 'smart';
    }
    if (mode === 'unordered') { this.diffUnordered(a, b, lpath, rpath); return; }
    if (mode === 'position') { this.diffByPosition(a.items, b.items, 0, 0, lpath, rpath); return; }
    var script = this.editScript(a.items, b.items);
    this.applyScript(script, a.items, b.items, lpath, rpath);
  };

  // Pairs items in order; extra items are added or removed.
  Differ.prototype.diffByPosition = function (la, ra, li, ri, lpath, rpath) {
    var common = Math.min(la.length, ra.length);
    var k;
    for (k = 0; k < common; k++) this.diff(la[k], ra[k], lpath.concat([li + k]), rpath.concat([ri + k]));
    for (k = common; k < la.length; k++) this.add('removed', lpath.concat([li + k]), null, la[k], null);
    for (k = common; k < ra.length; k++) this.add('added', null, rpath.concat([ri + k]), null, ra[k]);
  };

  // Longest common subsequence on item fingerprints: returns a list of steps.
  // ['=', i, j] same item, ['-', i] removed, ['+', j] added.
  Differ.prototype.editScript = function (la, ra) {
    var self = this;
    var start = 0;
    var endA = la.length;
    var endB = ra.length;
    while (start < endA && start < endB && self.equal(la[start], ra[start])) start++;
    while (endA > start && endB > start && self.equal(la[endA - 1], ra[endB - 1])) { endA--; endB--; }
    var steps = [];
    var x, y;
    for (x = 0; x < start; x++) steps.push(['=', x, x]);
    var n = endA - start;
    var m = endB - start;
    var middle = (n || m) ? this.myers(la, ra, start, n, m) : [];
    if (middle === null) {
      this.notes.lcsFallback++;
      for (x = 0; x < Math.max(n, m); x++) {
        if (x < n && x < m) steps.push(['~', start + x, start + x]);
        else if (x < n) steps.push(['-', start + x]);
        else steps.push(['+', start + x]);
      }
    } else {
      for (x = 0; x < middle.length; x++) steps.push(middle[x]);
    }
    for (x = endA, y = endB; x < la.length; x++, y++) steps.push(['=', x, y]);
    return steps;
  };

  // Myers' O(ND) difference algorithm (as used by git diff): fast when few items
  // differ, even in very long lists. Returns null if the lists differ too much.
  Differ.prototype.myers = function (la, ra, start, n, m) {
    var ids = Object.create(null), next = 0;
    var fa = new Array(n), fb = new Array(m), x, y, k, d;
    function id(f) { if (ids[f] === undefined) ids[f] = next++; return ids[f]; }
    for (x = 0; x < n; x++) fa[x] = id(fingerprint(la[start + x], this.ctx));
    for (y = 0; y < m; y++) fb[y] = id(fingerprint(ra[start + y], this.ctx));
    var max = n + m;
    var off = max + 1;
    var v = new Array(2 * max + 3);
    for (k = 0; k < v.length; k++) v[k] = 0;
    var trace = [];
    var work = 0;
    var found = -1;
    for (d = 0; d <= max && found < 0; d++) {
      trace.push(v.slice(off - d - 1, off + d + 2));
      work += 2 * d + 1;
      for (k = -d; k <= d; k += 2) {
        if (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) x = v[off + k + 1];
        else x = v[off + k - 1] + 1;
        y = x - k;
        while (x < n && y < m && fa[x] === fb[y]) { x++; y++; work++; }
        v[off + k] = x;
        if (x >= n && y >= m) { found = d; break; }
      }
      if (work > MAX_LCS_CELLS * 5) return null;
    }
    var out = [];
    x = n; y = m;
    for (d = found; d >= 0; d--) {
      var snap = trace[d];
      k = x - y;
      var prevK = (k === -d || (k !== d && snap[k - 1 + d + 1] < snap[k + 1 + d + 1])) ? k + 1 : k - 1;
      var prevX = snap[prevK + d + 1];
      var prevY = prevX - prevK;
      while (x > prevX && y > prevY) { out.push(['=', start + x - 1, start + y - 1]); x--; y--; }
      if (d > 0) {
        if (x === prevX) out.push(['+', start + y - 1]); else out.push(['-', start + x - 1]);
      }
      x = prevX; y = prevY;
    }
    out.reverse();
    return out;
  };

  // Within each run of removals and additions, items in the same position are
  // treated as changed (and compared inside); the rest are removed or added.
  Differ.prototype.applyScript = function (steps, la, ra, lpath, rpath) {
    var k = 0;
    while (k < steps.length) {
      var s = steps[k];
      if (s[0] === '=') { k++; continue; }
      if (s[0] === '~') { this.diff(la[s[1]], ra[s[2]], lpath.concat([s[1]]), rpath.concat([s[2]])); k++; continue; }
      var dels = [], adds = [];
      while (k < steps.length && (steps[k][0] === '-' || steps[k][0] === '+')) {
        if (steps[k][0] === '-') dels.push(steps[k][1]); else adds.push(steps[k][1]);
        k++;
      }
      var pairs = Math.min(dels.length, adds.length);
      for (var p = 0; p < pairs; p++) this.diff(la[dels[p]], ra[adds[p]], lpath.concat([dels[p]]), rpath.concat([adds[p]]));
      for (p = pairs; p < dels.length; p++) this.add('removed', lpath.concat([dels[p]]), null, la[dels[p]], null);
      for (p = pairs; p < adds.length; p++) this.add('added', null, rpath.concat([adds[p]]), null, ra[adds[p]]);
    }
  };

  Differ.prototype.diffUnordered = function (a, b, lpath, rpath) {
    var pool = Object.create(null);
    var k;
    for (k = 0; k < b.items.length; k++) {
      var f = fingerprint(b.items[k], this.ctx);
      (pool[f] = pool[f] || []).push(k);
    }
    var leftOver = [];
    var used = [];
    for (k = 0; k < a.items.length; k++) {
      var fp = fingerprint(a.items[k], this.ctx);
      if (pool[fp] && pool[fp].length) used[pool[fp].shift()] = true;
      else leftOver.push(k);
    }
    var rightOver = [];
    for (k = 0; k < b.items.length; k++) if (!used[k]) rightOver.push(k);
    var pairs = Math.min(leftOver.length, rightOver.length);
    for (k = 0; k < pairs; k++) {
      var li = leftOver[k], ri = rightOver[k];
      this.diff(a.items[li], b.items[ri], lpath.concat([li]), rpath.concat([ri]));
    }
    for (k = pairs; k < leftOver.length; k++) this.add('removed', lpath.concat([leftOver[k]]), null, a.items[leftOver[k]], null);
    for (k = pairs; k < rightOver.length; k++) this.add('added', null, rpath.concat([rightOver[k]]), null, b.items[rightOver[k]]);
  };

  // Matches objects by a key field such as "id". Returns false if it cannot.
  Differ.prototype.diffByKey = function (a, b, lpath, rpath) {
    var field = this.arrayKey;
    if (!field) return false;
    function index(items) {
      var map = Object.create(null);
      var count = 0;
      for (var k = 0; k < items.length; k++) {
        var it = items[k];
        if (it.t !== 'obj' || it.idx[field] === undefined) return null;
        var kv = it.vals[it.idx[field]];
        if (kv.t === 'obj' || kv.t === 'arr') return null;
        var id = kv.t === 'num' ? 'n' + kv.canon : kv.t + ':' + (kv.v === undefined ? '' : String(kv.v));
        if (map[id] !== undefined) return null;
        map[id] = k;
        count++;
      }
      return { map: map, count: count };
    }
    if (!a.items.length && !b.items.length) return true;
    var ia = index(a.items);
    var ib = index(b.items);
    if (!ia || !ib) return false;
    var id;
    for (var k = 0; k < a.items.length; k++) {
      var it = a.items[k];
      var kv = it.vals[it.idx[field]];
      id = kv.t === 'num' ? 'n' + kv.canon : kv.t + ':' + (kv.v === undefined ? '' : String(kv.v));
      if (ib.map[id] === undefined) this.add('removed', lpath.concat([k]), null, it, null);
      else this.diff(it, b.items[ib.map[id]], lpath.concat([k]), rpath.concat([ib.map[id]]));
    }
    for (k = 0; k < b.items.length; k++) {
      var bt = b.items[k];
      var bv = bt.vals[bt.idx[field]];
      id = bv.t === 'num' ? 'n' + bv.canon : bv.t + ':' + (bv.v === undefined ? '' : String(bv.v));
      if (ia.map[id] === undefined) this.add('added', null, rpath.concat([k]), null, bt);
    }
    return true;
  };

  /* =====================================================================
   * 4. JSON Patch (RFC 6902): turns the left JSON into the right JSON exactly
   * ===================================================================== */
  function pointer(path) {
    var out = '';
    for (var k = 0; k < path.length; k++) out += '/' + String(path[k]).replace(/~/g, '~0').replace(/\//g, '~1');
    return out;
  }

  // The patch always covers the whole document (ignored keys and list options do not
  // apply), so that applying it really gives the right side.
  function buildPatch(a, b, numbersByValue) {
    var strict = new Differ({ arrays: 'smart', numbersByValue: numbersByValue !== false });
    var ops = [];
    function walk(x, y, path) {
      if (x.t !== y.t || (x.t !== 'obj' && x.t !== 'arr')) {
        if (!strict.equal(x, y)) ops.push({ op: 'replace', path: pointer(path), value: y });
        return;
      }
      var k;
      if (x.t === 'obj') {
        for (k = 0; k < x.keys.length; k++) if (y.idx[x.keys[k]] === undefined) ops.push({ op: 'remove', path: pointer(path.concat([x.keys[k]])) });
        for (k = 0; k < y.keys.length; k++) {
          var key = y.keys[k];
          if (x.idx[key] === undefined) ops.push({ op: 'add', path: pointer(path.concat([key])), value: y.vals[k] });
          else walk(x.vals[x.idx[key]], y.vals[k], path.concat([key]));
        }
        return;
      }
      var steps = strict.editScript(x.items, y.items);
      var pos = 0;
      var s = 0;
      while (s < steps.length) {
        var st = steps[s];
        if (st[0] === '=') { pos++; s++; continue; }
        if (st[0] === '~') { walk(x.items[st[1]], y.items[st[2]], path.concat([pos])); pos++; s++; continue; }
        var dels = [], adds = [];
        while (s < steps.length && (steps[s][0] === '-' || steps[s][0] === '+')) {
          if (steps[s][0] === '-') dels.push(steps[s][1]); else adds.push(steps[s][1]);
          s++;
        }
        var pairs = Math.min(dels.length, adds.length);
        for (var p = 0; p < pairs; p++) { walk(x.items[dels[p]], y.items[adds[p]], path.concat([pos])); pos++; }
        for (p = pairs; p < dels.length; p++) ops.push({ op: 'remove', path: pointer(path.concat([pos])) });
        for (p = pairs; p < adds.length; p++) { ops.push({ op: 'add', path: pointer(path.concat([pos])), value: y.items[adds[p]] }); pos++; }
      }
    }
    walk(a, b, []);
    return ops;
  }

  function patchToJson(ops, indent) {
    if (!ops.length) return '[]';
    var lines = [];
    for (var k = 0; k < ops.length; k++) {
      var o = ops[k];
      var body = '{"op": ' + JSON.stringify(o.op) + ', "path": ' + JSON.stringify(o.path) +
        (o.value ? ', "value": ' + toJson(o.value, '', 0) : '') + '}';
      lines.push((indent ? '  ' : '') + body);
    }
    return indent ? '[\n' + lines.join(',\n') + '\n]' : '[' + lines.join(',') + ']';
  }

  /* =====================================================================
   * 5. Readable paths and the main entry point
   * ===================================================================== */
  function readablePath(path) {
    if (!path || !path.length) return '(whole document)';
    var out = '';
    for (var k = 0; k < path.length; k++) {
      var p = path[k];
      if (typeof p === 'number') out += '[' + p + ']';
      else if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(p)) out += (out ? '.' : '') + p;
      else out += '[' + JSON.stringify(p) + ']';
    }
    return out;
  }

  function shortValue(node) {
    if (!node) return '';
    var s;
    if (node.t === 'obj') s = node.keys.length ? '{' + node.keys.length + ' key' + (node.keys.length === 1 ? '' : 's') + '}' : '{}';
    else if (node.t === 'arr') s = node.items.length ? '[' + node.items.length + ' item' + (node.items.length === 1 ? '' : 's') + ']' : '[]';
    else s = toJson(node, '', 0);
    return s.length > 120 ? s.slice(0, 117) + '...' : s;
  }

  // The change list as a GitHub-flavoured Markdown table (for pull requests, tickets and chat).
  function changesToMarkdown(changes) {
    function cell(text) {
      text = String(text).replace(/\|/g, '\\|');
      if (!text) return '';
      var fence = text.indexOf('`') === -1 ? '`' : '``';
      return fence + (fence === '``' ? ' ' + text + ' ' : text) + fence;
    }
    var out = ['| Path | Change | Left | Right |', '| --- | --- | --- | --- |'];
    for (var k = 0; k < changes.length; k++) {
      var ch = changes[k];
      out.push('| ' + cell(changePath(ch)) + ' | ' + changeLabel(ch) + ' | ' + cell(shortValue(ch.left)) + ' | ' + cell(shortValue(ch.right)) + ' |');
    }
    return out.join('\n');
  }

  function changePath(ch) {
    var path = readablePath(ch.rpath || ch.lpath);
    if (ch.lpath && ch.rpath && readablePath(ch.lpath) !== readablePath(ch.rpath)) path = readablePath(ch.lpath) + ' → ' + readablePath(ch.rpath);
    return path;
  }

  function changeLabel(ch) {
    return ch.kind === 'type' ? 'Type: ' + typeName(ch.left) + ' → ' + typeName(ch.right) : ch.kind.charAt(0).toUpperCase() + ch.kind.slice(1);
  }

  function typeName(node) {
    return { obj: 'object', arr: 'array', str: 'text', num: 'number', bool: 'true/false', 'null': 'null' }[node.t];
  }

  function compare(leftText, rightText, userOpts) {
    var opts = {};
    var k;
    for (k in DEFAULTS) if (hasOwn(DEFAULTS, k)) opts[k] = DEFAULTS[k];
    if (userOpts) for (k in userOpts) if (hasOwn(userOpts, k) && userOpts[k] !== undefined) opts[k] = userOpts[k];

    var res = { ok: false, errors: [], notes: [], changes: [], stats: { added: 0, removed: 0, changed: 0, total: 0 }, patch: [], left: null, right: null };
    var L = parse(leftText, { jsonc: true });
    var R = parse(rightText, { jsonc: true });
    if (!L.ok) res.errors.push({ side: 'left', message: L.error.message, line: L.error.line, col: L.error.col });
    if (!R.ok) res.errors.push({ side: 'right', message: R.error.message, line: R.error.line, col: R.error.col });
    if (res.errors.length) return res;

    var d = new Differ(opts);
    d.diff(L.value, R.value, [], []);
    res.changes = d.changes;
    for (k = 0; k < d.changes.length; k++) {
      var c = d.changes[k];
      if (c.kind === 'added') res.stats.added++;
      else if (c.kind === 'removed') res.stats.removed++;
      else res.stats.changed++;
    }
    res.stats.total = d.changes.length;
    res.left = L.value;
    res.right = R.value;
    res.patch = buildPatch(L.value, R.value, opts.numbersByValue);
    res.patchCoversAll = !!(parseIgnore(opts.ignoreKeys).count || opts.arrays !== 'smart' || opts.nullEqualsMissing);

    [['Left', L.notes], ['Right', R.notes]].forEach(function (side) {
      var nt = side[1];
      if (nt.comments || nt.trailingCommas) {
        res.notes.push(side[0] + ' side: ' + [nt.comments ? nt.comments + ' comment' + (nt.comments === 1 ? '' : 's') : '',
          nt.trailingCommas ? nt.trailingCommas + ' trailing comma' + (nt.trailingCommas === 1 ? '' : 's') : ''].filter(Boolean).join(' and ') +
          ' ignored (allowed in JSONC files such as tsconfig.json, but not in strict JSON).');
      }
      if (nt.duplicates.length) {
        var names = [];
        for (var x = 0; x < nt.duplicates.length && names.length < 4; x++) names.push('"' + nt.duplicates[x].key + '" (line ' + nt.duplicates[x].line + ')');
        res.notes.push(side[0] + ' side: duplicate key' + (nt.duplicates.length === 1 ? '' : 's') + ' ' + names.join(', ') +
          (nt.duplicates.length > 4 ? ' ...' : '') + '. The last value was used, as JSON.parse() does; other tools may use the first.');
      }
    });
    if (d.notes.numberFormat) {
      res.notes.push(d.notes.numberFormat + ' number' + (d.notes.numberFormat === 1 ? ' is' : 's are') + ' written differently but equal in value (for example 1 and 1.0), so ' +
        (d.notes.numberFormat === 1 ? 'it was' : 'they were') + ' not counted. Untick "1 and 1.0 are equal" to count them.');
    }
    if (d.notes.nullMissing) res.notes.push(d.notes.nullMissing + ' key' + (d.notes.nullMissing === 1 ? '' : 's') + ' set to null on one side and missing on the other ' + (d.notes.nullMissing === 1 ? 'was' : 'were') + ' not counted ("Missing key = null" is ticked).');
    if (d.notes.ignored) res.notes.push(d.notes.ignored + ' value' + (d.notes.ignored === 1 ? '' : 's') + ' under ignored keys skipped.');
    if (d.notes.keyFallback) {
      res.notes.push(d.notes.keyFallback + ' list' + (d.notes.keyFallback === 1 ? '' : 's') + ' could not be matched by "' + d.arrayKey + '": ' +
        d.notes.keyFallbackPaths.join(', ') + (d.notes.keyFallback > d.notes.keyFallbackPaths.length ? ' and ' + (d.notes.keyFallback - d.notes.keyFallbackPaths.length) + ' more' : '') +
        ' (an item is not an object, has no "' + d.arrayKey + '", or two items share the same value), so ' + (d.notes.keyFallback === 1 ? 'it was' : 'they were') + ' compared by content instead.');
    }
    if (d.notes.lcsFallback) res.notes.push('A very long list was compared item by item by position to keep the browser responsive.');
    res.ok = true;
    return res;
  }

  /* =====================================================================
   * 6. Side-by-side view: pretty-printed lines with the lines of each change
   * ===================================================================== */
  function printWithMap(root) {
    var lines = [];
    var map = Object.create(null);
    function key(path) { return path.join('\u0000'); }
    function walk(node, path, depth, prefix, suffix) {
      var pad = repeat('  ', depth);
      var start = lines.length;
      if (node.t === 'obj' && node.keys.length) {
        lines.push(pad + prefix + '{');
        for (var k = 0; k < node.keys.length; k++) {
          walk(node.vals[k], path.concat([node.keys[k]]), depth + 1, JSON.stringify(node.keys[k]) + ': ', k < node.keys.length - 1 ? ',' : '');
        }
        lines.push(pad + '}' + suffix);
      } else if (node.t === 'arr' && node.items.length) {
        lines.push(pad + prefix + '[');
        for (var a = 0; a < node.items.length; a++) walk(node.items[a], path.concat([a]), depth + 1, '', a < node.items.length - 1 ? ',' : '');
        lines.push(pad + ']' + suffix);
      } else {
        lines.push(pad + prefix + toJson(node, '', 0) + suffix);
      }
      map[key(path)] = [start, lines.length - 1];
    }
    walk(root, [], 0, '', '');
    return { lines: lines, map: map, key: key };
  }

  /* =====================================================================
   * 7. Page UI
   * ===================================================================== */
  var SAMPLE_LEFT = '{\n' +
    '  "service": "billing-api",\n' +
    '  "version": "1.4.0",\n' +
    '  "replicas": 3,\n' +
    '  "timeout": 2.5,\n' +
    '  "accountId": 12345678901234567890,\n' +
    '  "updatedAt": "2026-11-24T09:15:00Z",\n' +
    '  "regions": ["eu-west-1", "us-east-1"],\n' +
    '  "users": [\n' +
    '    { "id": 1, "name": "Priya", "role": "admin" },\n' +
    '    { "id": 2, "name": "Liam", "role": "editor" }\n' +
    '  ]\n' +
    '}\n';
  var SAMPLE_RIGHT = '{\n' +
    '  "service": "billing-api",\n' +
    '  "version": "1.5.0",\n' +
    '  "replicas": 3,\n' +
    '  "timeout": 2.50,\n' +
    '  "accountId": 12345678901234567891,\n' +
    '  "updatedAt": "2026-11-25T08:00:00Z",\n' +
    '  "regions": ["eu-west-1", "ap-south-1", "us-east-1"],\n' +
    '  "users": [\n' +
    '    { "id": 1, "name": "Priya", "role": "owner" },\n' +
    '    { "id": 2, "name": "Liam", "role": "editor" },\n' +
    '    { "id": 3, "name": "Zoë", "role": "viewer" }\n' +
    '  ],\n' +
    '  "debug": false\n' +
    '}\n';

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        if (!hasOwn(attrs, k)) continue;
        if (k === 'class') node.className = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else node.setAttribute(k, attrs[k]);
      }
    }
    if (children) for (var i = 0; i < children.length; i++) if (children[i]) node.appendChild(children[i]);
    return node;
  }

  var uid = 0;
  function select(label, options, value) {
    var id = 'jc-' + (++uid);
    var s = el('select', { id: id, 'class': 'aptdot-select' });
    for (var i = 0; i < options.length; i++) {
      var o = el('option', { value: options[i][0], text: options[i][1] });
      if (options[i][0] === value) o.selected = true;
      s.appendChild(o);
    }
    return { wrap: el('div', { 'class': 'jc-field' }, [el('label', { 'for': id, 'class': 'jc-field-label', text: label }), s]), input: s };
  }
  function textInput(label, value, placeholder) {
    var id = 'jc-' + (++uid);
    var inp = el('input', { type: 'text', id: id, 'class': 'jc-text', value: value, placeholder: placeholder || '', spellcheck: 'false', autocomplete: 'off' });
    return { wrap: el('div', { 'class': 'jc-field' }, [el('label', { 'for': id, 'class': 'jc-field-label', text: label }), inp]), input: inp };
  }
  function checkbox(label, checked) {
    var id = 'jc-' + (++uid);
    var input = el('input', { type: 'checkbox', id: id });
    input.checked = !!checked;
    return { wrap: el('label', { 'for': id, 'class': 'jc-check' }, [input, document.createTextNode(' ' + label)]), input: input };
  }

  function copyText(text, done) {
    function fallback() {
      var ta = el('textarea', { 'aria-hidden': 'true' });
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      done(ok);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(function () { done(true); }, fallback);
    else fallback();
  }
  function download(name, text, type) {
    var blob = new Blob([text + '\n'], { type: type });
    var a = el('a', { download: name });
    a.href = URL.createObjectURL(blob);
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }

  function makeEditor(title, placeholder) {
    var fileInput = el('input', { type: 'file', accept: '.json,.jsonc,.txt,application/json,text/plain', 'class': 'jc-file' });
    var upload = el('label', { 'class': 'aptdot-file-upload-btn jc-upload' }, [fileInput, document.createTextNode('📂 Upload')]);
    var gutter = el('div', { 'class': 'aptdot-line-gutter jc-gutter', 'aria-hidden': 'true', text: '1' });
    var ta = el('textarea', {
      'class': 'jc-input', spellcheck: 'false', wrap: 'off', autocomplete: 'off', autocapitalize: 'off',
      'aria-label': title + ' JSON', placeholder: placeholder, 'data-gramm': 'false', 'data-enable-grammarly': 'false'
    });
    var frame = el('div', { 'class': 'aptdot-editor-frame jc-frame' }, [gutter, ta]);
    var nameEl = el('span', { 'class': 'jc-file-name' });
    var head = el('div', { 'class': 'jc-pane-head' }, [el('span', { 'class': 'jc-pane-title' }, [document.createTextNode(title), nameEl]), upload]);
    var wrap = el('div', { 'class': 'jc-pane' }, [head, frame]);
    function updateGutter() {
      var count = 1;
      var v = ta.value;
      for (var i = 0; i < v.length; i++) if (v.charCodeAt(i) === 10) count++;
      var parts = [];
      for (var n = 1; n <= Math.min(count, 20000); n++) parts.push(n);
      gutter.textContent = parts.join('\n');
      gutter.scrollTop = ta.scrollTop;
    }
    ta.addEventListener('scroll', function () { gutter.scrollTop = ta.scrollTop; });
    function setName(name) {
      nameEl.textContent = name ? ' · ' + name : '';
      nameEl.title = name || '';
    }
    return { wrap: wrap, ta: ta, file: fileInput, frame: frame, updateGutter: updateGutter, setName: setName, getName: function () { return nameEl.title; } };
  }

  function build(root) {
    if (root.getAttribute('data-ready')) return;
    root.textContent = '';
    root.setAttribute('data-ready', '1');
    var timer = null;

    var sampleBtn = el('button', { type: 'button', 'class': 'aptdot-tool-btn', text: '🧪 Load sample' });
    var swapBtn = el('button', { type: 'button', 'class': 'aptdot-tool-btn', text: '⇄ Swap sides' });
    var badge = el('span', { 'class': 'aptdot-privacy-badge', text: '🔒 100% Client-Side (Zero Server Storage)' });
    var topBar = el('div', { 'class': 'aptdot-top-bar' }, [
      el('div', { 'class': 'aptdot-top-left' }, [sampleBtn, swapBtn]),
      el('div', { 'class': 'aptdot-top-right' }, [badge])
    ]);
    var left = makeEditor('Left (original)', 'Paste the original JSON here, or upload a file...');
    var right = makeEditor('Right (changed)', 'Paste the changed JSON here, or upload a file...');
    var panes = el('div', { 'class': 'jc-panes' }, [left.wrap, right.wrap]);

    var arraysSel = select('Lists (arrays)', [['smart', 'Smart: find inserted items'], ['position', 'By position'], ['unordered', 'Ignore order'], ['key', 'Match items by key']], 'smart');
    var keyInput = textInput('Key field', 'id', 'id');
    var ignoreInput = textInput('Ignore keys', '', 'e.g. updatedAt, etag');
    var numbers = checkbox('1 and 1.0 are equal', true);
    var nulls = checkbox('Missing key = null', false);
    var compareBtn = el('button', { type: 'button', 'class': 'aptdot-tool-btn aptdot-primary', text: '⚡ Compare' });
    var clearBtn = el('button', { type: 'button', 'class': 'aptdot-tool-btn aptdot-clear', text: '🗑️ Clear' });
    var toolbar = el('div', { 'class': 'aptdot-bottom-toolbar jc-toolbar' }, [
      el('div', { 'class': 'aptdot-btn-row' }, [compareBtn, clearBtn]),
      el('div', { 'class': 'jc-options', role: 'group', 'aria-label': 'Comparison options' }, [numbers.wrap, nulls.wrap]),
      el('div', { 'class': 'aptdot-dropdown-row' }, [arraysSel.wrap, keyInput.wrap, ignoreInput.wrap])
    ]);
    keyInput.wrap.className = 'jc-field jc-hidden';

    var output = el('div', { 'class': 'aptdot-output-frame jc-output', 'aria-live': 'polite' }, [
      el('div', { 'class': 'aptdot-placeholder-text', text: 'Paste JSON on both sides to see the differences.' })
    ]);
    root.appendChild(el('div', { 'class': 'aptdot-tool-wrapper jc-wrapper' }, [topBar, panes, toolbar, output]));

    function options() {
      return { arrays: arraysSel.input.value, arrayKey: keyInput.input.value, ignoreKeys: ignoreInput.input.value, numbersByValue: numbers.input.checked, nullEqualsMissing: nulls.input.checked };
    }
    function placeholder(text) {
      output.textContent = '';
      output.appendChild(el('div', { 'class': 'aptdot-placeholder-text', text: text }));
    }

    function renderSide(title, printed, marks) {
      var box = el('div', { 'class': 'jc-side' });
      box.appendChild(el('div', { 'class': 'jc-side-title', text: title }));
      var pre = el('pre', { 'class': 'jc-view', tabindex: '0', 'aria-label': title });
      var max = Math.min(printed.lines.length, MAX_VIEW_LINES);
      var rows = [];
      for (var k = 0; k < max; k++) {
        var row = el('span', { 'class': 'jc-line' + (marks[k] ? ' jc-' + marks[k] : '') });
        rows.push(row);
        row.appendChild(el('span', { 'class': 'jc-ln', text: String(k + 1) }));
        row.appendChild(document.createTextNode(printed.lines[k]));
        pre.appendChild(row);
        pre.appendChild(document.createTextNode('\n'));
      }
      box.appendChild(pre);
      if (printed.lines.length > max) box.appendChild(el('div', { 'class': 'aptdot-placeholder-text', text: 'Showing the first ' + max.toLocaleString() + ' of ' + printed.lines.length.toLocaleString() + ' lines.' }));
      return { box: box, pre: pre, rows: rows };
    }

    function render(res) {
      output.textContent = '';
      if (!res.ok) {
        var errBox = el('div', { 'class': 'aptdot-report-box jc-error', role: 'alert' });
        errBox.appendChild(el('strong', { text: '❌ Could not read the JSON' }));
        for (var e = 0; e < res.errors.length; e++) {
          var er = res.errors[e];
          errBox.appendChild(el('div', { 'class': 'jc-msg', text: (er.side === 'left' ? 'Left' : 'Right') + ' side, line ' + er.line + ', column ' + er.col + ': ' + er.message + '.' }));
        }
        output.appendChild(errBox);
        return;
      }
      var st = res.stats;
      var summary = st.total === 0 ? '✅ No differences: the two JSON documents are equal' :
        st.total.toLocaleString() + ' difference' + (st.total === 1 ? '' : 's') + ': ' + st.changed + ' changed · ' + st.added + ' added · ' + st.removed + ' removed';
      output.appendChild(el('div', { 'class': 'aptdot-panel-header' }, [
        el('div', { 'class': 'jc-title-wrap' }, [el('span', { 'class': 'aptdot-panel-title' + (st.total ? ' jc-has-diff' : ''), text: summary })])
      ]));
      if (res.notes.length) {
        var box = el('div', { 'class': 'aptdot-report-box jc-warn' });
        box.appendChild(el('strong', { text: 'ℹ️ ' + res.notes.length + ' note' + (res.notes.length === 1 ? '' : 's') }));
        var nl = el('ul', { 'class': 'jc-list' });
        for (var w = 0; w < res.notes.length; w++) nl.appendChild(el('li', { text: res.notes[w] }));
        box.appendChild(nl);
        output.appendChild(box);
      }
      if (!st.total && !res.patch.length) return;

      if (st.total) {
        // Side-by-side view (built first so the change list can jump to its lines)
        var lp = printWithMap(res.left), rp = printWithMap(res.right);
        var lm = [], rm = [];
        var mark = function (printed, marks, path, cls) {
          if (!path) return;
          var span = printed.map[printed.key(path)];
          if (!span) return;
          for (var x = span[0]; x <= span[1]; x++) marks[x] = cls;
        };
        var c;
        for (c = 0; c < res.changes.length; c++) {
          var cg = res.changes[c];
          if (cg.kind === 'removed') mark(lp, lm, cg.lpath, 'del');
          else if (cg.kind === 'added') mark(rp, rm, cg.rpath, 'add');
          else { mark(lp, lm, cg.lpath, 'chg'); mark(rp, rm, cg.rpath, 'chg'); }
        }
        var ls = renderSide('Left', lp, lm), rs = renderSide('Right', rp, rm);
        var sides = el('div', { 'class': 'jc-sides' }, [ls.box, rs.box]);
        var lineOf = function (printed, path) {
          if (!path) return -1;
          var span = printed.map[printed.key(path)];
          return span ? span[0] : -1;
        };
        var flashTimer = null;
        var unflash = function () {
          var lit = sides.querySelectorAll('.jc-flash');
          for (var f = 0; f < lit.length; f++) lit[f].className = lit[f].className.replace(/ jc-flash/g, '');
        };
        var jump = function (ch) {
          if (flashTimer) { clearTimeout(flashTimer); flashTimer = null; }
          unflash();
          var targets = [[ls, lineOf(lp, ch.lpath)], [rs, lineOf(rp, ch.rpath)]];
          var shown = false;
          for (var t = 0; t < 2; t++) {
            var side = targets[t][0], line = targets[t][1];
            if (line < 0 || line >= side.rows.length) continue;
            var row = side.rows[line];
            side.pre.scrollTop = Math.max(0, row.offsetTop - side.pre.offsetTop - side.pre.clientHeight / 3);
            row.className += ' jc-flash';
            shown = true;
          }
          if (shown && sides.scrollIntoView) sides.scrollIntoView({ block: 'nearest' });
          flashTimer = setTimeout(function () { flashTimer = null; unflash(); }, 1600);
        };

        // Change list
        var mdBtn = el('button', { type: 'button', 'class': 'aptdot-tool-btn', text: '📋 Copy as Markdown' });
        output.appendChild(el('div', { 'class': 'jc-list-head' }, [
          el('span', { 'class': 'jc-stats', text: 'Click a path to show it in the side-by-side view.' }), mdBtn
        ]));
        var table = el('table', { 'class': 'jc-table' });
        table.appendChild(el('thead', null, [el('tr', null, [el('th', { scope: 'col', text: 'Path' }), el('th', { scope: 'col', text: 'Change' }), el('th', { scope: 'col', text: 'Left' }), el('th', { scope: 'col', text: 'Right' })])]));
        var tb = el('tbody');
        var addRow = function (ch) {
          var btn = el('button', { type: 'button', 'class': 'jc-jump', title: 'Show in the side-by-side view' }, [el('code', { text: changePath(ch) })]);
          btn.addEventListener('click', function () { jump(ch); });
          tb.appendChild(el('tr', { 'class': 'jc-row-' + ch.kind }, [
            el('td', null, [btn]),
            el('td', { text: changeLabel(ch) }),
            el('td', null, [el('code', { text: shortValue(ch.left) })]),
            el('td', null, [el('code', { text: shortValue(ch.right) })])
          ]));
        };
        for (c = 0; c < res.changes.length && c < MAX_LIST; c++) addRow(res.changes[c]);
        table.appendChild(tb);
        output.appendChild(el('div', { 'class': 'jc-table-wrap' }, [table]));
        if (res.changes.length > MAX_LIST) output.appendChild(el('div', { 'class': 'aptdot-placeholder-text', text: 'Showing the first ' + MAX_LIST + ' of ' + res.changes.length.toLocaleString() + ' differences. "Copy as Markdown" and the JSON Patch below include all of them.' }));
        mdBtn.addEventListener('click', function () {
          copyText(changesToMarkdown(res.changes), function (ok) {
            mdBtn.textContent = ok ? '✔ Copied' : 'Copy failed';
            setTimeout(function () { mdBtn.textContent = '📋 Copy as Markdown'; }, 2000);
          });
        });
        output.appendChild(sides);
      }

      // JSON Patch
      var patchText = patchToJson(res.patch, true);
      var copyBtn = el('button', { type: 'button', 'class': 'aptdot-tool-btn', text: '📋 Copy' });
      var dlBtn = el('button', { type: 'button', 'class': 'aptdot-tool-btn', text: '💾 Download .json' });
      output.appendChild(el('div', { 'class': 'aptdot-panel-header jc-patch-head' }, [
        el('div', { 'class': 'jc-title-wrap' }, [
          el('span', { 'class': 'aptdot-panel-title', text: 'JSON Patch (RFC 6902)' }),
          el('span', { 'class': 'jc-stats', text: res.patch.length + ' operation' + (res.patch.length === 1 ? '' : 's') + ' that turn the left JSON into the right JSON' +
            (!st.total ? ' (the documents differ only in what your options ignore; the patch always covers the whole document)' :
              res.patchCoversAll ? ' (the whole document: your ignore and list options do not apply to the patch)' : '') })
        ]),
        el('div', { 'class': 'aptdot-panel-actions' }, [copyBtn, dlBtn])
      ]));
      output.appendChild(el('pre', { 'class': 'jc-patch', tabindex: '0', 'aria-label': 'JSON Patch' }, [el('code', { text: patchText })]));
      copyBtn.addEventListener('click', function () {
        copyText(patchText, function (ok) {
          copyBtn.textContent = ok ? '✔ Copied' : 'Copy failed: select the text instead';
          setTimeout(function () { copyBtn.textContent = '📋 Copy'; }, 2000);
        });
      });
      dlBtn.addEventListener('click', function () { download('json-patch.json', patchText, 'application/json-patch+json'); });
    }

    function run() {
      if (timer) { clearTimeout(timer); timer = null; }
      if (!left.ta.value.replace(/\s+/g, '') || !right.ta.value.replace(/\s+/g, '')) { placeholder('Paste JSON on both sides to see the differences.'); return; }
      render(compare(left.ta.value, right.ta.value, options()));
    }
    function schedule() {
      if (timer) clearTimeout(timer);
      if (left.ta.value.length + right.ta.value.length > AUTO_LIMIT) { placeholder('Large input: click "Compare" to compare.'); return; }
      timer = setTimeout(run, 400);
    }
    function wire(ed) {
      ed.ta.addEventListener('input', function () { ed.updateGutter(); schedule(); });
      ed.file.addEventListener('change', function () {
        var f = ed.file.files && ed.file.files[0];
        if (f) readInto(ed, f);
        ed.file.value = '';
      });
      ed.frame.addEventListener('dragover', function (e) { e.preventDefault(); ed.frame.className = 'aptdot-editor-frame jc-frame aptdot-drag-over'; });
      ed.frame.addEventListener('dragleave', function (e) {
        if (e.relatedTarget && ed.frame.contains(e.relatedTarget)) return;
        ed.frame.className = 'aptdot-editor-frame jc-frame';
      });
      ed.frame.addEventListener('drop', function (e) {
        e.preventDefault();
        ed.frame.className = 'aptdot-editor-frame jc-frame';
        var files = e.dataTransfer && e.dataTransfer.files;
        if (files && files[0]) readInto(ed, files[0]);
      });
    }
    function readInto(ed, file) {
      var reader = new FileReader();
      reader.onload = function () { ed.ta.value = String(reader.result || ''); ed.setName(file.name); ed.updateGutter(); schedule(); };
      reader.onerror = function () { placeholder('That file could not be read.'); };
      reader.readAsText(file);
    }
    wire(left);
    wire(right);
    arraysSel.input.addEventListener('change', function () {
      keyInput.wrap.className = arraysSel.input.value === 'key' ? 'jc-field' : 'jc-field jc-hidden';
      if (left.ta.value && right.ta.value) run();
    });
    [keyInput.input, ignoreInput.input].forEach(function (inp) { inp.addEventListener('input', schedule); });
    [numbers.input, nulls.input].forEach(function (box) { box.addEventListener('change', function () { if (left.ta.value && right.ta.value) run(); }); });
    compareBtn.addEventListener('click', run);
    clearBtn.addEventListener('click', function () {
      left.ta.value = '';
      right.ta.value = '';
      left.setName('');
      right.setName('');
      left.updateGutter();
      right.updateGutter();
      placeholder('Paste JSON on both sides to see the differences.');
      left.ta.focus();
    });
    swapBtn.addEventListener('click', function () {
      var t = left.ta.value, n = left.getName();
      left.ta.value = right.ta.value;
      right.ta.value = t;
      left.setName(right.getName());
      right.setName(n);
      left.updateGutter();
      right.updateGutter();
      run();
    });
    sampleBtn.addEventListener('click', function () {
      left.ta.value = SAMPLE_LEFT;
      right.ta.value = SAMPLE_RIGHT;
      left.setName('');
      right.setName('');
      ignoreInput.input.value = '';
      left.updateGutter();
      right.updateGutter();
      run();
    });
  }

  function boot() {
    var roots = document.querySelectorAll('.aptdot-json-compare');
    for (var i = 0; i < roots.length; i++) build(roots[i]);
  }

  // Exposed for automated tests; not used by the page.
  window.AptdotJsonCompare = {
    compare: compare, parse: parse, canonNumber: canonNumber, toJson: toJson,
    patchToJson: patchToJson, readablePath: readablePath, changesToMarkdown: changesToMarkdown, sample: { left: SAMPLE_LEFT, right: SAMPLE_RIGHT }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
