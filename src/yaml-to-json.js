/*!
 * Aptdot YAML to JSON converter v1.0.1
 * https://www.aptdot.com/tools/yaml-to-json/
 * MIT License (c) 2026 Aptdot. Source: https://github.com/mkchd25/aptdot-json-suite
 *
 * Runs entirely in the browser: no network requests, nothing stored.
 * YAML is read by the "yaml" library (vendor/yaml.min.js, ISC license); this
 * file walks the parsed document and writes the JSON itself, so that:
 *  - numbers are written exactly as in the YAML (1.10 stays 1.10, and very
 *    large integers keep every digit);
 *  - numbers written with a leading zero (02115, 0644) can stay text;
 *  - YAML 1.2 rules apply: NO, yes, on and dates stay text;
 *  - key order, merge keys (<<), sets, anchors and aliases are kept correctly;
 *  - CloudFormation tags (!Ref, !Sub, !GetAtt ...) become their JSON forms;
 *  - alias bombs and self-referencing aliases are stopped with a clear error.
 */
(function () {
  'use strict';

  var PREVIEW_LINES = 3000;
  var AUTO_LIMIT = 1024 * 1024;     // convert while typing below 1 MB
  var MAX_WARNINGS = 25;
  var MAX_VALUES = 2000000;         // alias-bomb guard
  var JSON_NUMBER = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+\-]?\d+)?$/;
  var LEADING_ZERO = /^[-+]?0\d+(\.\d*)?$/;
  var CFN = {
    Ref: 1, Condition: 1, GetAtt: 1, Base64: 1, Cidr: 1, FindInMap: 1, GetAZs: 1, ImportValue: 1,
    Join: 1, Select: 1, Split: 1, Sub: 1, Transform: 1, And: 1, Equals: 1, If: 1, Not: 1, Or: 1,
    Length: 1, ToJsonString: 1
  };

  var DEFAULTS = {
    documents: 'array',      // 'array' | 'jsonl' | 'first'
    merge: true,             // apply << merge keys
    duplicates: 'error',     // 'error' | 'last'
    leadingZeros: 'text',    // 'text' | 'number'
    bigIntegers: 'exact',    // 'exact' (digits kept as a JSON number) | 'text'
    tags: 'auto',            // 'auto' (CloudFormation style, others kept as keys) | 'key' | 'drop'
    indent: 2                // 2 | 4 | '\t' | 0
  };

  function hasOwn(obj, key) { return Object.prototype.hasOwnProperty.call(obj, key); }

  /* ---------- Intermediate tree (keeps key order; no prototype risk) ---------- */
  function newObj() { return { t: 'obj', keys: [], vals: [], idx: Object.create(null) }; }
  function objHas(o, k) { return o.idx[k] !== undefined; }
  function objSet(o, k, v) {
    if (o.idx[k] !== undefined) { o.vals[o.idx[k]] = v; return; }
    o.idx[k] = o.keys.length;
    o.keys.push(k);
    o.vals.push(v);
  }
  var NULL = { t: 'raw', s: 'null' };
  function str(s) { return { t: 'str', s: String(s) }; }
  function raw(s) { return { t: 'raw', s: s }; }

  function write(v, indent, depth) {
    if (v.t === 'raw') return v.s;
    if (v.t === 'str') return JSON.stringify(v.s);
    var pad = indent ? repeat(indent, depth + 1) : '';
    var end = indent ? '\n' + repeat(indent, depth) : '';
    var sep = indent ? ',\n' : ',';
    var parts = [];
    var i;
    if (v.t === 'arr') {
      if (!v.items.length) return '[]';
      for (i = 0; i < v.items.length; i++) parts.push(pad + write(v.items[i], indent, depth + 1));
      return '[' + (indent ? '\n' : '') + parts.join(sep) + end + ']';
    }
    if (!v.keys.length) return '{}';
    for (i = 0; i < v.keys.length; i++) {
      parts.push(pad + JSON.stringify(v.keys[i]) + (indent ? ': ' : ':') + write(v.vals[i], indent, depth + 1));
    }
    return '{' + (indent ? '\n' : '') + parts.join(sep) + end + '}';
  }
  function repeat(s, n) { var out = ''; for (var i = 0; i < n; i++) out += s; return out; }

  /* ---------- Conversion ---------- */
  function Converter(lib, doc, opts, notes) {
    this.lib = lib;
    this.doc = doc;
    this.opts = opts;
    this.notes = notes;
    this.count = 0;
    this.stack = [];
  }

  Converter.prototype.fail = function (message) {
    var e = new Error(message);
    e.aptdot = true;
    throw e;
  };

  Converter.prototype.value = function (node) {
    var lib = this.lib;
    if (++this.count > MAX_VALUES) {
      this.fail('This YAML expands to more than ' + MAX_VALUES.toLocaleString() + ' values through its aliases (*name). ' +
        'That is usually an "alias bomb", so conversion was stopped to protect your browser.');
    }
    if (node === null || node === undefined) return NULL;
    if (lib.isAlias(node)) return this.alias(node);
    var tag = node.tag;
    var tree;
    if (lib.isScalar(node)) tree = this.scalar(node, tag);
    else if (lib.isMap(node)) tree = this.map(node);
    else if (lib.isSeq(node)) tree = this.seq(node);
    else if (lib.isPair(node)) tree = this.pairAsObject(node);
    else tree = NULL;
    if (tag && isCustomTag(tag)) tree = this.applyTag(tag, tree, node);
    return tree;
  };

  Converter.prototype.alias = function (node) {
    var target = node.resolve(this.doc);
    if (!target) this.fail('The alias *' + node.source + ' does not match any anchor (&' + node.source + ').');
    if (this.stack.indexOf(target) !== -1) {
      this.fail('The alias *' + node.source + ' refers to the value that contains it, so it would never end. JSON cannot represent this.');
    }
    this.stack.push(target);
    var v = this.value(target);
    this.stack.pop();
    return v;
  };

  Converter.prototype.scalar = function (node, tag) {
    var v = node.value;
    var src = typeof node.source === 'string' ? node.source : String(v);
    if (tag === 'tag:yaml.org,2002:binary') {
      this.notes.binary++;
      return str(typeof v === 'string' ? v : src.replace(/\s+/g, ''));
    }
    if (tag === 'tag:yaml.org,2002:timestamp') return str(src);
    if (typeof v === 'string') return str(v);
    if (v === null || v === undefined) return NULL;
    if (typeof v === 'boolean') return raw(v ? 'true' : 'false');
    if (typeof v !== 'number' && typeof v !== 'bigint') return str(src);
    var plain = node.type === 'PLAIN';
    if (plain && /^[-+]?\d+(:[0-5]?\d)+(\.\d*)?$/.test(src)) this.notes.base60.push(src);
    if (plain && LEADING_ZERO.test(src) && this.opts.leadingZeros === 'text') {
      this.notes.leadingZero.push(src);
      return str(src);
    }
    if (typeof v === 'bigint') {
      // Integers are read exactly (any size, also hex, octal and !!int "..."),
      // and written as plain decimal digits, which is always valid JSON.
      var digits = String(v);
      if (v > 9007199254740991 || v < -9007199254740991) {
        this.notes.bigInt.push(src);
        if (this.opts.bigIntegers === 'text') return str(digits);
      }
      return raw(digits);
    }
    if (!isFinite(v)) {
      this.notes.nonFinite.push(src);
      return NULL;
    }
    if (plain && JSON_NUMBER.test(src)) return raw(src);
    if (plain && /^\+/.test(src) && JSON_NUMBER.test(src.slice(1))) return raw(src.slice(1));
    return raw(JSON.stringify(v));
  };

  Converter.prototype.keyText = function (keyNode) {
    var lib = this.lib;
    if (keyNode === null || keyNode === undefined) return '';
    if (lib.isAlias(keyNode)) {
      var target = keyNode.resolve(this.doc);
      if (!target) this.fail('The alias *' + keyNode.source + ' does not match any anchor (&' + keyNode.source + ').');
      if (this.stack.indexOf(target) !== -1) {
        this.fail('The alias *' + keyNode.source + ' refers to the value that contains it, so it would never end. JSON cannot represent this.');
      }
      this.stack.push(target);
      var text = this.keyText(target);
      this.stack.pop();
      return text;
    }
    if (keyNode && lib.isScalar(keyNode)) {
      if (typeof keyNode.value === 'string') return keyNode.value;
      if (keyNode.value === null || keyNode.value === undefined) return 'null';
      if (keyNode.type === 'PLAIN' && typeof keyNode.source === 'string') return keyNode.source;
      return String(keyNode.value);
    }
    this.notes.complexKeys++;
    return write(this.value(keyNode), 0, 0);
  };

  Converter.prototype.map = function (node) {
    var lib = this.lib;
    var out = newObj();
    var explicit = Object.create(null);
    for (var i = 0; i < node.items.length; i++) {
      var pair = node.items[i];
      var keyNode = pair.key;
      if (keyNode && lib.isScalar(keyNode) && typeof keyNode.value === 'symbol') {
        this.merge(out, pair.value);
        continue;
      }
      var k = this.keyText(keyNode);
      var val = this.value(pair.value);
      if (explicit[k]) this.notes.duplicates.push(k);
      explicit[k] = true;
      objSet(out, k, val);
    }
    return out;
  };

  Converter.prototype.merge = function (out, valueNode) {
    var lib = this.lib;
    var sources = [];
    if (valueNode && lib.isSeq(valueNode)) sources = valueNode.items;
    else sources = [valueNode];
    this.notes.merges++;
    for (var s = 0; s < sources.length; s++) {
      var tree = this.value(sources[s]);
      if (tree.t !== 'obj') this.fail('A merge key (<<) must point to a mapping (key: value pairs), or a list of them.');
      for (var j = 0; j < tree.keys.length; j++) {
        if (!objHas(out, tree.keys[j])) objSet(out, tree.keys[j], tree.vals[j]);
      }
    }
  };

  Converter.prototype.seq = function (node) {
    var items = [];
    for (var i = 0; i < node.items.length; i++) items.push(this.value(node.items[i]));
    return { t: 'arr', items: items };
  };

  Converter.prototype.pairAsObject = function (pair) {
    var out = newObj();
    objSet(out, this.keyText(pair.key), this.value(pair.value));
    return out;
  };

  function isCustomTag(tag) {
    if (tag.charAt(0) === '!') return true;
    if (tag.indexOf('tag:yaml.org,2002:') === 0) {
      return !/^tag:yaml\.org,2002:(str|int|float|bool|null|map|seq|binary|timestamp|set|omap|pairs|merge|value)$/.test(tag);
    }
    return true;
  }

  Converter.prototype.applyTag = function (tag, tree, node) {
    var mode = this.opts.tags;
    var name = tag.charAt(0) === '!' ? tag.slice(1) : tag;
    var label = tag.charAt(0) === '!' ? tag : '!<' + tag + '>';
    if (mode === 'drop') {
      this.notes.tagsDropped[label] = (this.notes.tagsDropped[label] || 0) + 1;
      return tree;
    }
    var out = newObj();
    if (mode === 'auto' && tag.charAt(0) === '!' && CFN[name] === 1) {
      this.notes.tagsCfn[label] = (this.notes.tagsCfn[label] || 0) + 1;
      if (name === 'Ref' || name === 'Condition') {
        objSet(out, name, tree);
      } else if (name === 'GetAtt' && tree.t === 'str') {
        var dot = tree.s.indexOf('.');
        objSet(out, 'Fn::GetAtt', dot === -1 ? { t: 'arr', items: [tree] }
          : { t: 'arr', items: [str(tree.s.slice(0, dot)), str(tree.s.slice(dot + 1))] });
      } else {
        objSet(out, 'Fn::' + name, tree);
      }
      return out;
    }
    this.notes.tagsKept[label] = (this.notes.tagsKept[label] || 0) + 1;
    objSet(out, label, tree);
    return out;
  };

  function lineCol(err) {
    if (err && err.linePos && err.linePos[0]) return { line: err.linePos[0].line, col: err.linePos[0].col };
    return null;
  }

  function describeError(err) {
    var first = String(err && err.message || err).split('\n')[0].replace(/:\s*$/, '');
    var pos = lineCol(err);
    if (pos && first.indexOf('line ' + pos.line) === -1) first += ' (line ' + pos.line + ', column ' + pos.col + ')';
    if (err && err.code === 'DUPLICATE_KEY') {
      first += '. Each key may appear only once in a mapping; choose "Duplicate keys: last one wins" to keep the last value.';
    }
    return first;
  }

  function newNotes() {
    return {
      leadingZero: [], bigInt: [], nonFinite: [], base60: [], duplicates: [], binary: 0, merges: 0, complexKeys: 0,
      tagsCfn: {}, tagsKept: {}, tagsDropped: {}
    };
  }

  function listSome(arr) {
    var uniq = [];
    for (var i = 0; i < arr.length && uniq.length < 4; i++) if (uniq.indexOf(arr[i]) === -1) uniq.push(arr[i]);
    return uniq.join(', ') + (arr.length > uniq.length ? ' ...' : '');
  }
  function tagList(map) {
    var parts = [];
    var total = 0;
    for (var k in map) if (hasOwn(map, k)) { parts.push(k); total += map[k]; }
    return { total: total, names: parts.slice(0, 6).join(', ') + (parts.length > 6 ? ' ...' : '') };
  }

  function notesToWarnings(n, opts, warnings) {
    if (n.leadingZero.length) {
      warnings.push(n.leadingZero.length + ' number' + (n.leadingZero.length === 1 ? '' : 's') + ' written with a leading zero (' +
        listSome(n.leadingZero) + ') kept as text. YAML 1.2 would read 02115 as 2115 and older YAML 1.1 tools as an octal number, ' +
        'so text is the only safe choice. Choose "Leading zeros: number" to follow YAML 1.2.');
    }
    if (n.bigInt.length) {
      warnings.push(n.bigInt.length + ' integer' + (n.bigInt.length === 1 ? ' is' : 's are') + ' too large for JavaScript to hold exactly (' +
        listSome(n.bigInt) + '). ' + (opts.bigIntegers === 'text'
          ? 'They are written as text.'
          : 'Every digit is kept in the JSON, but JSON.parse() in JavaScript would round them; choose "Large integers: text" for JavaScript.'));
    }
    if (n.nonFinite.length) {
      warnings.push(listSome(n.nonFinite) + ' (infinity or not-a-number) cannot be written in JSON and became null.');
    }
    if (n.base60.length) {
      warnings.push(listSome(n.base60) + ' read as base-60 (sexagesimal) numbers under YAML 1.1, so 1:30 became 90. Quote the value to keep it as text.');
    }
    if (n.duplicates.length) {
      warnings.push('Duplicate keys (' + listSome(n.duplicates) + '): the last value was kept.');
    }
    if (n.binary) warnings.push(n.binary + ' !!binary value' + (n.binary === 1 ? '' : 's') + ' kept as base64 text.');
    if (n.complexKeys) warnings.push(n.complexKeys + ' key' + (n.complexKeys === 1 ? ' is' : 's are') + ' a list or mapping; JSON keys must be text, so ' + (n.complexKeys === 1 ? 'it was' : 'they were') + ' written as JSON text.');
    var c = tagList(n.tagsCfn);
    if (c.total) warnings.push(c.total + ' CloudFormation tag' + (c.total === 1 ? '' : 's') + ' (' + c.names + ') converted to the JSON form, such as {"Ref": ...} and {"Fn::Sub": ...}.');
    var k = tagList(n.tagsKept);
    if (k.total) warnings.push(k.total + ' custom tag' + (k.total === 1 ? '' : 's') + ' (' + k.names + ') kept as a key, such as {"' + k.names.split(',')[0] + '": value}, so the information is not lost.');
    var d = tagList(n.tagsDropped);
    if (d.total) warnings.push(d.total + ' custom tag' + (d.total === 1 ? '' : 's') + ' (' + d.names + ') removed; only the values were kept.');
  }

  // A document with nothing in it (for example a trailing ---) rather than an explicit null (~).
  function isEmptyDocument(lib, doc) {
    var c = doc.contents;
    if (c === null || c === undefined) return true;
    return lib.isScalar(c) && c.value === null && !c.tag && !c.anchor && (c.source === '' || c.source === undefined);
  }

  function convert(text, userOpts) {
    var opts = {};
    var k;
    for (k in DEFAULTS) if (hasOwn(DEFAULTS, k)) opts[k] = DEFAULTS[k];
    if (userOpts) for (k in userOpts) if (hasOwn(userOpts, k) && userOpts[k] !== undefined) opts[k] = userOpts[k];

    var result = { ok: false, errors: [], warnings: [], stats: { documents: 0, values: 0, version: '1.2' }, json: '' };
    var lib = window.AptdotYAMLLib;
    if (!lib) { result.errors.push('The YAML reader did not load. Please reload the page.'); return result; }

    var src = String(text || '').replace(/^\uFEFF/, '');
    var docs;
    // A %YAML 1.1 directive asks for YAML 1.1 rules (yes/no/on/off are booleans);
    // everything else is read with YAML 1.2 core rules.
    var declares11 = /^%YAML[ \t]+1\.1(?:[ \t]+#[^\r\n]*)?[ \t]*\r?$/m.test(src);
    var parseOpts = { merge: !!opts.merge, uniqueKeys: opts.duplicates !== 'last', prettyErrors: true, strict: true, intAsBigInt: true };
    if (declares11) parseOpts.version = '1.1';
    else { parseOpts.version = '1.2'; parseOpts.schema = 'core'; }
    try {
      docs = lib.parseAllDocuments(src, parseOpts);
    } catch (e) {
      result.errors.push(describeError(e));
      return result;
    }
    if (!docs || !docs.length || docs.length === undefined) {
      result.errors.push('No YAML found: the input contains only comments or blank lines.');
      return result;
    }

    var notes = newNotes();
    var trees = [];
    var emptyDocs = 0;
    var oldVersion = false;
    for (var d = 0; d < docs.length; d++) {
      var doc = docs[d];
      if (doc.errors && doc.errors.length) {
        for (var e = 0; e < doc.errors.length && e < 5; e++) {
          result.errors.push((docs.length > 1 ? 'Document ' + (d + 1) + ': ' : '') + describeError(doc.errors[e]));
        }
        return result;
      }
      for (var w = 0; w < (doc.warnings || []).length; w++) {
        var wn = doc.warnings[w];
        if (wn.code === 'TAG_RESOLVE_FAILED') continue;
        result.warnings.push(describeError(wn));
      }
      if (declares11) oldVersion = true;
      if (docs.length > 1 && isEmptyDocument(lib, doc)) { emptyDocs++; continue; }
      var conv = new Converter(lib, doc, opts, notes);
      try {
        trees.push(conv.value(doc.contents));
      } catch (err) {
        if (err && err.aptdot) result.errors.push((docs.length > 1 ? 'Document ' + (d + 1) + ': ' : '') + err.message);
        else if (err instanceof RangeError) result.errors.push('This YAML is nested too deeply to convert in the browser.');
        else result.errors.push(describeError(err));
        return result;
      }
      result.stats.values += conv.count;
    }

    notesToWarnings(notes, opts, result.warnings);
    if (oldVersion) {
      result.stats.version = '1.1';
      result.warnings.push('The file declares %YAML 1.1, so it was read with YAML 1.1 rules: yes, no, on and off are true or false.');
    }
    if (notes.merges) result.warnings.push(notes.merges + ' merge key' + (notes.merges === 1 ? '' : 's') + ' (<<) applied.');
    if (emptyDocs) result.warnings.push(emptyDocs + ' empty document' + (emptyDocs === 1 ? '' : 's') + ' (only --- or comments) skipped.');

    var indent = opts.indent === '\t' || opts.indent === 'tab' ? '\t' : (parseInt(opts.indent, 10) > 0 ? repeat(' ', parseInt(opts.indent, 10)) : '');
    result.stats.documents = trees.length;
    if (trees.length === 0) {
      result.json = 'null';
    } else if (trees.length === 1) {
      result.json = opts.documents === 'jsonl' ? write(trees[0], '', 0) : write(trees[0], indent, 0);
    } else if (opts.documents === 'jsonl') {
      var lines = [];
      for (var t = 0; t < trees.length; t++) lines.push(write(trees[t], '', 0));
      result.json = lines.join('\n');
    } else if (opts.documents === 'first') {
      result.json = write(trees[0], indent, 0);
      result.warnings.push('Only the first of ' + trees.length + ' documents was converted.');
    } else {
      result.json = write({ t: 'arr', items: trees }, indent, 0);
      result.warnings.push(trees.length + ' documents (separated by ---) became one JSON array.');
    }
    result.ok = true;
    return result;
  }

  /* ---------- Page UI ---------- */
  var SAMPLE = '# Service settings with an anchor (&) and merge keys (<<)\n' +
    'defaults: &defaults\n' +
    '  region: eu-west-1\n' +
    '  retries: 3\n' +
    '  timeout: 2.50\n' +
    '\n' +
    'services:\n' +
    '  api:\n' +
    '    <<: *defaults\n' +
    '    image: ghcr.io/example/api:1.4.0\n' +
    '    port: 8080\n' +
    '    enabled: true\n' +
    '  billing:\n' +
    '    <<: *defaults\n' +
    '    retries: 5\n' +
    '    country: NO            # stays "NO" under YAML 1.2\n' +
    '    postcode: 02115        # leading zero kept as text\n' +
    '    account_id: 12345678901234567890\n' +
    '    notes: |\n' +
    '      Multi-line text keeps\n' +
    '      its line breaks.\n';

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
  function checkbox(label, checked, title) {
    var id = 'y2j-' + (++uid);
    var input = el('input', { type: 'checkbox', id: id });
    input.checked = !!checked;
    var lab = el('label', { 'for': id, 'class': 'y2j-check', title: title || '' }, [input, document.createTextNode(' ' + label)]);
    return { wrap: lab, input: input };
  }
  function select(label, options, value, title) {
    var id = 'y2j-' + (++uid);
    var s = el('select', { id: id, 'class': 'aptdot-select', title: title || '' });
    for (var i = 0; i < options.length; i++) {
      var o = el('option', { value: options[i][0], text: options[i][1] });
      if (options[i][0] === value) o.selected = true;
      s.appendChild(o);
    }
    var lab = el('div', { 'class': 'y2j-field' }, [el('label', { 'for': id, 'class': 'y2j-field-label', text: label }), s]);
    return { wrap: lab, input: s };
  }

  function renderJson(container, json) {
    var frag = document.createDocumentFragment();
    var re = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+\-]?\d+)?)/g;
    var last = 0;
    var m;
    while ((m = re.exec(json)) !== null) {
      if (m.index > last) frag.appendChild(document.createTextNode(json.slice(last, m.index)));
      if (m[1] && m[2]) {
        frag.appendChild(el('span', { 'class': 'token-key', text: m[1] }));
        frag.appendChild(document.createTextNode(m[2]));
      } else {
        var cls = m[1] ? 'token-string' : (m[3] ? (m[3] === 'null' ? 'token-null' : 'token-boolean') : 'token-number');
        frag.appendChild(el('span', { 'class': cls, text: m[0] }));
      }
      last = re.lastIndex;
    }
    if (last < json.length) frag.appendChild(document.createTextNode(json.slice(last)));
    container.appendChild(frag);
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

  function build(root) {
    if (root.getAttribute('data-ready')) return;
    root.textContent = '';
    root.setAttribute('data-ready', '1');
    var state = { fileName: '', timer: null };

    var fileInput = el('input', { type: 'file', accept: '.yaml,.yml,.txt,text/yaml,application/yaml,text/plain', 'class': 'y2j-file' });
    var uploadLabel = el('label', { 'class': 'aptdot-file-upload-btn' }, [fileInput, document.createTextNode('📂 Upload YAML')]);
    var sampleBtn = el('button', { type: 'button', 'class': 'aptdot-tool-btn', text: '🧪 Load sample' });
    var badge = el('span', { 'class': 'aptdot-privacy-badge', text: '🔒 100% Client-Side (Zero Server Storage)' });
    var topBar = el('div', { 'class': 'aptdot-top-bar' }, [
      el('div', { 'class': 'aptdot-top-left' }, [uploadLabel, sampleBtn]),
      el('div', { 'class': 'aptdot-top-right' }, [badge])
    ]);

    var gutter = el('div', { 'class': 'aptdot-line-gutter y2j-gutter', 'aria-hidden': 'true', text: '1' });
    var input = el('textarea', {
      'class': 'y2j-input', spellcheck: 'false', wrap: 'off', autocomplete: 'off', autocapitalize: 'off',
      'aria-label': 'YAML input', placeholder: 'Paste YAML here, drag & drop a .yaml file, or click "Load sample"...',
      'data-gramm': 'false', 'data-enable-grammarly': 'false'
    });
    var editor = el('div', { 'class': 'aptdot-editor-frame' }, [gutter, input]);

    var optMerge = checkbox('Apply merge keys (<<)', true, 'Copy the keys of an anchored mapping into the mapping that uses <<: *name');
    var docsSel = select('Multiple documents', [['array', 'JSON array'], ['jsonl', 'JSON Lines'], ['first', 'First only']], 'array');
    var dupSel = select('Duplicate keys', [['error', 'Show an error'], ['last', 'Last one wins']], 'error');
    var zeroSel = select('Leading zeros (02115)', [['text', 'Keep as text'], ['number', 'Number (YAML 1.2)']], 'text');
    var bigSel = select('Large integers', [['exact', 'Exact number'], ['text', 'Text']], 'exact',
      'Integers above 9,007,199,254,740,991 lose digits in JavaScript. Exact keeps every digit as a JSON number; Text keeps them as strings.');
    var tagSel = select('Custom tags (!Ref)', [['auto', 'CloudFormation style'], ['key', 'Keep tag as key'], ['drop', 'Drop tags']], 'auto');
    var indentSel = select('Indent', [['2', '2 spaces'], ['4', '4 spaces'], ['tab', 'Tab'], ['0', 'Minified']], '2');

    var convertBtn = el('button', { type: 'button', 'class': 'aptdot-tool-btn aptdot-primary', text: '⚡ Convert to JSON' });
    var clearBtn = el('button', { type: 'button', 'class': 'aptdot-tool-btn aptdot-clear', text: '🗑️ Clear' });
    var toolbar = el('div', { 'class': 'aptdot-bottom-toolbar y2j-toolbar' }, [
      el('div', { 'class': 'aptdot-btn-row' }, [convertBtn, clearBtn]),
      el('div', { 'class': 'y2j-options', role: 'group', 'aria-label': 'Conversion options' }, [optMerge.wrap]),
      el('div', { 'class': 'aptdot-dropdown-row' }, [docsSel.wrap, dupSel.wrap, zeroSel.wrap, bigSel.wrap, tagSel.wrap, indentSel.wrap])
    ]);
    var output = el('div', { 'class': 'aptdot-output-frame y2j-output', 'aria-live': 'polite' }, [
      el('div', { 'class': 'aptdot-placeholder-text', text: 'Your JSON appears here as soon as you paste or upload YAML.' })
    ]);
    root.appendChild(el('div', { 'class': 'aptdot-tool-wrapper y2j-wrapper' }, [topBar, editor, toolbar, output]));

    function options() {
      var ind = indentSel.input.value;
      return {
        merge: optMerge.input.checked, documents: docsSel.input.value, duplicates: dupSel.input.value,
        leadingZeros: zeroSel.input.value, bigIntegers: bigSel.input.value, tags: tagSel.input.value,
        indent: ind === 'tab' ? '\t' : parseInt(ind, 10)
      };
    }
    function updateGutter() {
      var count = 1;
      var v = input.value;
      for (var i = 0; i < v.length; i++) if (v.charCodeAt(i) === 10) count++;
      var parts = [];
      for (var n = 1; n <= Math.min(count, 20000); n++) parts.push(n);
      gutter.textContent = parts.join('\n');
      gutter.scrollTop = input.scrollTop;
    }
    function showPlaceholder(text) {
      output.textContent = '';
      output.appendChild(el('div', { 'class': 'aptdot-placeholder-text', text: text }));
    }
    function render(res) {
      output.textContent = '';
      if (!res.ok) {
        var errBox = el('div', { 'class': 'aptdot-report-box y2j-error', role: 'alert' });
        errBox.appendChild(el('strong', { text: '❌ Could not convert this YAML' }));
        for (var e = 0; e < res.errors.length; e++) errBox.appendChild(el('div', { 'class': 'y2j-msg', text: res.errors[e] }));
        output.appendChild(errBox);
        return;
      }
      var opts = options();
      var multi = res.stats.documents > 1;
      var ext = (opts.documents === 'jsonl' && multi) ? 'jsonl' : 'json';
      var stats = res.stats.documents + ' document' + (res.stats.documents === 1 ? '' : 's') + ' · ' +
        res.stats.values.toLocaleString() + ' value' + (res.stats.values === 1 ? '' : 's') + ' · YAML ' + res.stats.version;
      var copyBtn = el('button', { type: 'button', 'class': 'aptdot-tool-btn', text: '📋 Copy' });
      var dlBtn = el('button', { type: 'button', 'class': 'aptdot-tool-btn', text: '💾 Download .' + ext });
      output.appendChild(el('div', { 'class': 'aptdot-panel-header' }, [
        el('div', { 'class': 'y2j-title-wrap' }, [
          el('span', { 'class': 'aptdot-panel-title', text: '✅ JSON output' }),
          el('span', { 'class': 'y2j-stats', text: stats })
        ]),
        el('div', { 'class': 'aptdot-panel-actions' }, [copyBtn, dlBtn])
      ]));
      if (res.warnings.length) {
        var box = el('div', { 'class': 'aptdot-report-box y2j-warn' });
        box.appendChild(el('strong', { text: 'ℹ️ ' + res.warnings.length + ' note' + (res.warnings.length === 1 ? '' : 's') }));
        var list = el('ul', { 'class': 'y2j-list' });
        for (var w = 0; w < res.warnings.length && w < MAX_WARNINGS; w++) list.appendChild(el('li', { text: res.warnings[w] }));
        if (res.warnings.length > MAX_WARNINGS) {
          list.appendChild(el('li', { text: '... and ' + (res.warnings.length - MAX_WARNINGS) + ' more' }));
        }
        box.appendChild(list);
        output.appendChild(box);
      }
      var pre = el('pre', { 'class': 'y2j-code', tabindex: '0', 'aria-label': 'JSON output' });
      var code = el('code');
      var lines = res.json.split('\n');
      var text = lines.length > PREVIEW_LINES ? lines.slice(0, PREVIEW_LINES).join('\n') : res.json;
      if (text.length < 400000) renderJson(code, text); else code.textContent = text;
      pre.appendChild(code);
      output.appendChild(pre);
      if (lines.length > PREVIEW_LINES) {
        output.appendChild(el('div', { 'class': 'aptdot-placeholder-text y2j-more',
          text: 'Preview shows the first ' + PREVIEW_LINES.toLocaleString() + ' of ' + lines.length.toLocaleString() + ' lines. Copy and Download include everything.' }));
      }
      copyBtn.addEventListener('click', function () {
        copyText(res.json, function (ok) {
          copyBtn.textContent = ok ? '✔ Copied' : 'Copy failed: select the text instead';
          setTimeout(function () { copyBtn.textContent = '📋 Copy'; }, 2000);
        });
      });
      dlBtn.addEventListener('click', function () {
        var base = (state.fileName || 'converted').replace(/\.[^.]+$/, '') || 'converted';
        var blob = new Blob([res.json + '\n'], { type: ext === 'jsonl' ? 'application/x-ndjson' : 'application/json' });
        var a = el('a', { download: base + '.' + ext });
        a.href = URL.createObjectURL(blob);
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
      });
    }
    function run() {
      if (state.timer) { clearTimeout(state.timer); state.timer = null; }
      if (!input.value.replace(/\s+/g, '')) { showPlaceholder('Your JSON appears here as soon as you paste or upload YAML.'); return; }
      render(convert(input.value, options()));
    }
    function schedule() {
      if (state.timer) clearTimeout(state.timer);
      if (input.value.length > AUTO_LIMIT) { showPlaceholder('Large input: click "Convert to JSON" to convert it.'); return; }
      state.timer = setTimeout(run, 300);
    }
    function readFile(file) {
      if (!file) return;
      state.fileName = file.name || '';
      var reader = new FileReader();
      reader.onload = function () { input.value = String(reader.result || ''); updateGutter(); run(); };
      reader.onerror = function () { showPlaceholder('That file could not be read.'); };
      reader.readAsText(file);
    }

    input.addEventListener('input', function () { state.fileName = ''; updateGutter(); schedule(); });
    input.addEventListener('scroll', function () { gutter.scrollTop = input.scrollTop; });
    input.addEventListener('keydown', function (e) {
      // Tab inserts two spaces (YAML does not allow tab indentation); Shift+Tab leaves the editor.
      if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        var s = input.selectionStart;
        input.value = input.value.slice(0, s) + '  ' + input.value.slice(input.selectionEnd);
        input.selectionStart = input.selectionEnd = s + 2;
        updateGutter();
        schedule();
      }
    });
    convertBtn.addEventListener('click', run);
    clearBtn.addEventListener('click', function () {
      input.value = '';
      state.fileName = '';
      updateGutter();
      showPlaceholder('Your JSON appears here as soon as you paste or upload YAML.');
      input.focus();
    });
    sampleBtn.addEventListener('click', function () { input.value = SAMPLE; state.fileName = 'sample.yaml'; updateGutter(); run(); });
    fileInput.addEventListener('change', function () {
      if (fileInput.files && fileInput.files[0]) readFile(fileInput.files[0]);
      fileInput.value = '';
    });
    var controls = [optMerge.input, docsSel.input, dupSel.input, zeroSel.input, bigSel.input, tagSel.input, indentSel.input];
    for (var i = 0; i < controls.length; i++) controls[i].addEventListener('change', function () { if (input.value) run(); });
    editor.addEventListener('dragover', function (e) { e.preventDefault(); editor.className = 'aptdot-editor-frame aptdot-drag-over'; });
    editor.addEventListener('dragleave', function (e) {
      if (e.relatedTarget && editor.contains(e.relatedTarget)) return;
      editor.className = 'aptdot-editor-frame';
    });
    editor.addEventListener('drop', function (e) {
      e.preventDefault();
      editor.className = 'aptdot-editor-frame';
      var files = e.dataTransfer && e.dataTransfer.files;
      if (files && files[0]) readFile(files[0]);
    });
  }

  function boot() {
    var roots = document.querySelectorAll('.aptdot-yaml2json');
    for (var i = 0; i < roots.length; i++) build(roots[i]);
  }

  // Exposed for automated tests; not used by the page.
  window.AptdotYamlToJson = { convert: convert, sample: SAMPLE, defaults: DEFAULTS };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
