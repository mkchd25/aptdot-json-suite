/*!
 * Aptdot CSV to JSON Converter (v1.0)
 * Runs entirely in the browser: no network requests, no storage.
 * Rules: ES5 only; text from the user is only ever written with textContent.
 */
(function () {
  'use strict';

  var CANDIDATES = [',', '\t', ';', '|'];
  var DELIM_NAMES = { ',': 'comma', '\t': 'tab', ';': 'semicolon', '|': 'pipe' };
  var PREVIEW_LINES = 3000;
  var AUTO_LIMIT = 2 * 1024 * 1024; // auto-convert while typing below 2 MB
  var MAX_WARNINGS = 25;
  var NUMBER_RE = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+\-]?\d+)?$/;

  /* ------------------------------------------------------------------
   * Parsing
   * ------------------------------------------------------------------ */

  function stripBom(s) {
    return s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s;
  }

  // Excel can write "sep=;" as the first line to declare the delimiter.
  function readSepHint(text) {
    var m = /^sep=(.)\r?\n/i.exec(text);
    if (!m) return null;
    return { delimiter: m[1], rest: text.slice(m[0].length) };
  }

  // Count candidate delimiters per line (outside quotes) over the first lines,
  // and pick the one with the most consistent non-zero count.
  function detectDelimiter(text) {
    var counts = {};
    var c, i, d;
    for (i = 0; i < CANDIDATES.length; i++) counts[CANDIDATES[i]] = [];
    var current = {};
    for (i = 0; i < CANDIDATES.length; i++) current[CANDIDATES[i]] = 0;
    var inQuotes = false;
    var lines = 0;
    var limit = Math.min(text.length, 65536);
    for (i = 0; i < limit && lines < 30; i++) {
      c = text.charAt(i);
      if (c === '"') {
        inQuotes = !inQuotes;
      } else if (!inQuotes && (c === '\n' || c === '\r')) {
        if (c === '\r' && text.charAt(i + 1) === '\n') i++;
        for (d in current) { counts[d].push(current[d]); current[d] = 0; }
        lines++;
      } else if (!inQuotes && current.hasOwnProperty(c)) {
        current[c]++;
      }
    }
    if (lines < 30) for (d in current) counts[d].push(current[d]);

    var best = ',';
    var bestScore = -1;
    for (i = 0; i < CANDIDATES.length; i++) {
      d = CANDIDATES[i];
      var arr = counts[d].filter(function (n, idx, all) { return !(n === 0 && idx === all.length - 1 && all.length > 1); });
      var freq = {};
      var mode = 0;
      var modeHits = 0;
      for (var j = 0; j < arr.length; j++) {
        var n = arr[j];
        if (n === 0) continue;
        freq[n] = (freq[n] || 0) + 1;
        if (freq[n] > modeHits || (freq[n] === modeHits && n > mode)) { mode = n; modeHits = freq[n]; }
      }
      if (!mode) continue;
      var score = (modeHits / arr.length) * 1000 + Math.min(mode, 50);
      if (score > bestScore) { bestScore = score; best = d; }
    }
    return best;
  }

  /**
   * RFC 4180 parser with practical tolerance.
   * Returns { rows: [[string]], rowLines: [lineNumber], errors: [], warnings: [], blankLines: n }
   */
  function parseCsv(text, delimiter) {
    var rows = [];
    var rowLines = [];
    var warnings = [];
    var errors = [];
    var row = [];
    var field = '';
    var quoted = false;        // current field started with a quote
    var inQuotes = false;
    var afterQuote = false;    // just closed a quoted field
    var line = 1;
    var col = 1;
    var rowStartLine = 1;
    var quoteStartLine = 0;
    var quoteStartCol = 0;
    var blankLines = 0;
    var strayWarned = 0;
    var len = text.length;

    function warnStray(msg) {
      if (strayWarned < 5) warnings.push(msg);
      strayWarned++;
    }

    function endField() {
      row.push(field);
      field = '';
      quoted = false;
      afterQuote = false;
    }

    function endRow() {
      endField();
      if (row.length === 1 && row[0] === '' && !rowHadQuotes) {
        blankLines++;
      } else {
        rows.push(row);
        rowLines.push(rowStartLine);
      }
      row = [];
      rowHadQuotes = false;
    }

    var rowHadQuotes = false;

    for (var i = 0; i < len; i++) {
      var c = text.charAt(i);
      if (inQuotes) {
        if (c === '"') {
          if (text.charAt(i + 1) === '"') {
            field += '"';
            i++; col++;
          } else {
            inQuotes = false;
            afterQuote = true;
          }
        } else {
          if (c === '\r' || c === '\n') {
            if (c === '\r' && text.charAt(i + 1) === '\n') { field += '\r\n'; i++; } else { field += c; }
            line++; col = 0;
          } else {
            field += c;
          }
        }
        col++;
        continue;
      }

      if (c === delimiter) {
        endField();
        col++;
        continue;
      }
      if (c === '\r' || c === '\n') {
        if (c === '\r' && text.charAt(i + 1) === '\n') i++;
        endRow();
        line++; col = 1;
        rowStartLine = line;
        continue;
      }
      if (c === '"') {
        if (field === '' && !quoted && !afterQuote) {
          inQuotes = true;
          quoted = true;
          rowHadQuotes = true;
          quoteStartLine = line;
          quoteStartCol = col;
        } else {
          warnStray('Line ' + line + ', column ' + col + ': a quote inside an unquoted value was kept as text.');
          field += c;
        }
        col++;
        continue;
      }
      if (afterQuote) {
        warnStray('Line ' + line + ', column ' + col + ': text after a closing quote was kept as part of the value.');
        afterQuote = false;
      }
      field += c;
      col++;
    }

    if (inQuotes) {
      errors.push('A quoted value that starts at line ' + quoteStartLine + ', column ' + quoteStartCol +
        ' is never closed. Add the missing closing " (and write quotes inside quoted values as "").');
    }
    if (field !== '' || row.length > 0 || quoted) endRow();
    if (strayWarned > 5) warnings.push('… and ' + (strayWarned - 5) + ' more stray quotes.');

    return { rows: rows, rowLines: rowLines, errors: errors, warnings: warnings, blankLines: blankLines };
  }

  /* ------------------------------------------------------------------
   * Conversion
   * ------------------------------------------------------------------ */

  function setProp(obj, key, value) {
    Object.defineProperty(obj, key, { value: value, enumerable: true, writable: true, configurable: true });
  }

  function hasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  function significantDigits(s) {
    var digits = s.replace(/^-/, '').replace(/[eE].*$/, '').replace('.', '').replace(/^0+/, '');
    return digits.length;
  }

  function convertValue(raw, opts) {
    var s = opts.trim ? raw.replace(/^\s+|\s+$/g, '') : raw;
    if (opts.unguard && /^'[=+\-@\t\r]/.test(s)) s = s.slice(1);
    if (s === '') {
      if (opts.empty === 'null') return null;
      if (opts.empty === 'omit') return undefined;
      return '';
    }
    if (opts.jsonCells) {
      var t = s.replace(/^\s+|\s+$/g, '');
      var first = t.charAt(0);
      var last = t.charAt(t.length - 1);
      if ((first === '{' && last === '}') || (first === '[' && last === ']')) {
        try {
          var parsed = JSON.parse(t);
          if (parsed !== null && typeof parsed === 'object') return parsed;
        } catch (e) { /* not JSON: keep the text */ }
      }
    }
    if (opts.types) {
      if (s === 'true' || s === 'TRUE' || s === 'True') return true;
      if (s === 'false' || s === 'FALSE' || s === 'False') return false;
      if (s === 'null') return null;
      if (NUMBER_RE.test(s)) {
        var isInteger = /^-?\d+$/.test(s);
        var n = Number(s);
        if (!isFinite(n)) return s;
        if (isInteger && Math.abs(n) > 9007199254740991) return s;       // would lose digits
        if (!isInteger && significantDigits(s) > 15) return s;            // would lose precision
        return n;
      }
    }
    return s;
  }

  function makeHeaders(raw, warnings) {
    var headers = [];
    var seen = {};
    for (var i = 0; i < raw.length; i++) {
      var h = raw[i].replace(/^\s+|\s+$/g, '');
      if (h === '') {
        h = 'column_' + (i + 1);
        warnings.push('Column ' + (i + 1) + ' has no header, so it was named "' + h + '".');
      }
      if (hasOwn(seen, h)) {
        var n = 2;
        while (hasOwn(seen, h + '_' + n)) n++;
        warnings.push('Header "' + h + '" appears more than once; the repeat was renamed "' + h + '_' + n + '".');
        h = h + '_' + n;
      }
      setProp(seen, h, true);
      headers.push(h);
    }
    return headers;
  }

  // Decide, per header, whether it becomes a nested path (a.b.c) or stays flat.
  function planPaths(headers, nested, warnings) {
    var plans = [];
    var i;
    if (!nested) {
      for (i = 0; i < headers.length; i++) plans.push([headers[i]]);
      return plans;
    }
    var leafSet = {};
    var prefixSet = {};
    for (i = 0; i < headers.length; i++) {
      var parts = headers[i].split('.');
      var ok = parts.length > 1;
      for (var j = 0; j < parts.length && ok; j++) if (parts[j] === '') ok = false;
      plans.push(ok ? parts : [headers[i]]);
    }
    for (i = 0; i < plans.length; i++) {
      setProp(leafSet, plans[i].join('\u0000'), true);
      for (var k = 1; k < plans[i].length; k++) setProp(prefixSet, plans[i].slice(0, k).join('\u0000'), true);
    }
    for (i = 0; i < plans.length; i++) {
      if (plans[i].length === 1) continue;
      var conflict = false;
      for (var p = 1; p < plans[i].length; p++) {
        if (hasOwn(leafSet, plans[i].slice(0, p).join('\u0000'))) { conflict = true; break; }
      }
      if (hasOwn(prefixSet, plans[i].join('\u0000'))) conflict = true;
      if (conflict) {
        warnings.push('Header "' + headers[i] + '" clashes with another column, so it was kept as a flat key.');
        plans[i] = [headers[i]];
      }
    }
    // A flat header that equals a nested prefix (e.g. "address" and "address.city") stays flat too.
    for (i = 0; i < plans.length; i++) {
      if (plans[i].length === 1 && hasOwn(prefixSet, plans[i][0])) {
        for (var q = 0; q < plans.length; q++) {
          if (plans[q].length > 1 && plans[q][0] === plans[i][0]) {
            warnings.push('Header "' + plans[q].join('.') + '" clashes with column "' + plans[i][0] + '", so it was kept as a flat key.');
            plans[q] = [plans[q].join('.')];
          }
        }
      }
    }
    return plans;
  }

  function assignPath(obj, path, value) {
    var target = obj;
    for (var i = 0; i < path.length - 1; i++) {
      var key = path[i];
      if (!hasOwn(target, key) || target[key] === null || typeof target[key] !== 'object') setProp(target, key, {});
      target = target[key];
    }
    setProp(target, path[path.length - 1], value);
  }

  // With "same type for whole column": a column keeps number/boolean types only if
  // every non-empty value in it converts to that type; otherwise the whole column stays text.
  function planColumnTypes(rows, start, width, opts) {
    var typed = [];
    for (var j = 0; j < width; j++) {
      var kind = '';
      var mixed = false;
      for (var r = start; r < rows.length && !mixed; r++) {
        if (j >= rows[r].length) continue;
        var v = convertValue(rows[r][j], opts);
        if (v === undefined || v === null || v === '' || typeof v === 'object') continue;
        var t = typeof v;
        if (t === 'string') { mixed = true; break; }
        if (!kind) kind = t; else if (kind !== t) mixed = true;
      }
      typed.push(!mixed);
    }
    return typed;
  }

  function valueFor(raw, j, typedCols, opts, textOpts) {
    return convertValue(raw, (!typedCols || typedCols[j]) ? opts : textOpts);
  }

  /**
   * opts: { delimiter: 'auto'|',' etc, header, types, consistent, jsonCells, nested, trim, unguard,
   *         empty: 'string'|'null'|'omit', output: 'objects'|'arrays'|'ndjson', indent: 2|4|'\t'|0 }
   */
  // Defaults match the tool's initial settings, so convert(text) behaves like the page.
  var DEFAULTS = {
    delimiter: 'auto', header: true, types: true, consistent: true, jsonCells: true,
    nested: true, trim: false, unguard: false, empty: 'string', output: 'objects', indent: 2
  };

  function convert(text, userOpts) {
    var opts = {}, k;
    for (k in DEFAULTS) if (hasOwn(DEFAULTS, k)) opts[k] = DEFAULTS[k];
    if (userOpts) for (k in userOpts) if (hasOwn(userOpts, k) && userOpts[k] !== undefined) opts[k] = userOpts[k];
    var result = { ok: false, errors: [], warnings: [], stats: {}, json: '', data: null };
    var src = stripBom(String(text || ''));
    var delimiter = opts.delimiter || 'auto';
    var detected = false;
    var hint = readSepHint(src);
    if (hint) {
      src = hint.rest;
      if (delimiter === 'auto') delimiter = hint.delimiter;
    }
    if (delimiter === 'auto' || !delimiter) {
      delimiter = detectDelimiter(src);
      detected = true;
    }
    result.stats.delimiter = delimiter;
    result.stats.detected = detected;

    if (src.replace(/\s+/g, '') === '') {
      result.errors.push('Paste CSV data or upload a .csv file to convert it.');
      return result;
    }

    var parsed = parseCsv(src, delimiter);
    result.errors = parsed.errors;
    result.warnings = parsed.warnings.slice();
    if (parsed.errors.length) return result;

    var rows = parsed.rows;
    var data;
    var textOpts = {};
    for (var key in opts) if (hasOwn(opts, key)) textOpts[key] = opts[key];
    textOpts.types = false;
    var widest = 0;
    for (var w = 0; w < rows.length; w++) if (rows[w].length > widest) widest = rows[w].length;
    var typedCols = (opts.types && opts.consistent) ? planColumnTypes(rows, opts.header ? 1 : 0, widest, opts) : null;
    var columns = 0;
    var dataRows = 0;
    var i, j, r;

    if (opts.header) {
      if (!rows.length) { result.errors.push('No rows found.'); return result; }
      var headers = makeHeaders(rows[0], result.warnings);
      columns = headers.length;
      var plans = planPaths(headers, opts.nested && opts.output !== 'arrays', result.warnings);
      var ragged = 0;
      data = [];
      for (r = 1; r < rows.length; r++) {
        var cells = rows[r];
        if (cells.length !== headers.length) {
          if (ragged < 5) {
            result.warnings.push('Line ' + parsed.rowLines[r] + ' has ' + cells.length + ' value' + (cells.length === 1 ? '' : 's') +
              ' but the header has ' + headers.length + '. ' +
              (cells.length > headers.length ? 'Extra values were put in "_extra".' : 'Missing values were treated as empty.'));
          }
          ragged++;
        }
        if (opts.output === 'arrays') {
          var arr = [];
          for (j = 0; j < cells.length; j++) {
            var av = valueFor(cells[j], j, typedCols, opts, textOpts);
            arr.push(av === undefined ? null : av);
          }
          data.push(arr);
        } else {
          var obj = {};
          for (j = 0; j < headers.length; j++) {
            var v = valueFor(j < cells.length ? cells[j] : '', j, typedCols, opts, textOpts);
            if (v !== undefined) assignPath(obj, plans[j], v);
          }
          if (cells.length > headers.length) {
            var extra = [];
            for (j = headers.length; j < cells.length; j++) {
              var ev = valueFor(cells[j], j, typedCols, opts, textOpts);
              extra.push(ev === undefined ? null : ev);
            }
            setProp(obj, hasOwn(obj, '_extra') ? '_extra_values' : '_extra', extra);
          }
          data.push(obj);
        }
        dataRows++;
      }
      if (ragged > 5) result.warnings.push('… and ' + (ragged - 5) + ' more lines with a different number of values.');
      if (opts.output === 'arrays') data.unshift(headers.slice());
      if (!dataRows) result.warnings.push('Only a header row was found, so the result is empty.');
    } else {
      data = [];
      for (r = 0; r < rows.length; r++) {
        var line = [];
        for (j = 0; j < rows[r].length; j++) {
          var lv = valueFor(rows[r][j], j, typedCols, opts, textOpts);
          line.push(lv === undefined ? null : lv);
        }
        if (rows[r].length > columns) columns = rows[r].length;
        data.push(line);
        dataRows++;
      }
    }

    if (parsed.blankLines) result.warnings.push(parsed.blankLines + ' blank line' + (parsed.blankLines === 1 ? ' was' : 's were') + ' skipped.');

    result.stats.rows = dataRows;
    result.stats.columns = columns;
    result.data = data;
    if (opts.output === 'ndjson') {
      var out = [];
      for (i = 0; i < data.length; i++) out.push(JSON.stringify(data[i]));
      result.json = out.join('\n');
    } else {
      result.json = JSON.stringify(data, null, opts.indent);
    }
    result.ok = true;
    return result;
  }

  /* ------------------------------------------------------------------
   * UI (DOM only, no innerHTML)
   * ------------------------------------------------------------------ */

  var SAMPLE = 'id,name,email,active,zip,address.city,address.country,tags,notes\r\n' +
    '1,Priya Nair,priya@example.com,true,02115,London,UK,"[""admin"",""editor""]","Prefers email, not phone"\r\n' +
    '2,"O\'Connor, Liam",liam@example.com,false,,Dublin,IE,[],"Line one\r\nline two"\r\n' +
    '3,Mei Chen,mei@example.com,TRUE,98101,Seattle,US,"[""viewer""]",\r\n';

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
    var id = 'c2j-' + (++uid);
    var input = el('input', { type: 'checkbox', id: id });
    input.checked = !!checked;
    var lab = el('label', { 'for': id, 'class': 'c2j-check', title: title || '' }, [input, document.createTextNode(' ' + label)]);
    return { wrap: lab, input: input };
  }

  function select(label, options, value) {
    var id = 'c2j-' + (++uid);
    var s = el('select', { id: id, 'class': 'aptdot-select' });
    for (var i = 0; i < options.length; i++) {
      var o = el('option', { value: options[i][0], text: options[i][1] });
      if (options[i][0] === value) o.selected = true;
      s.appendChild(o);
    }
    // Label sits beside the select (not around it) so its accessible name is just the label text.
    var lab = el('div', { 'class': 'c2j-field' }, [el('label', { 'for': id, 'class': 'c2j-field-label', text: label }), s]);
    return { wrap: lab, input: s };
  }

  // Highlight JSON produced by JSON.stringify, building DOM nodes (no HTML strings).
  function renderJson(container, json) {
    var frag = document.createDocumentFragment();
    var re = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+\-]?\d+)?)/g;
    var last = 0;
    var m;
    while ((m = re.exec(json)) !== null) {
      if (m.index > last) frag.appendChild(document.createTextNode(json.slice(last, m.index)));
      var cls;
      var text = m[0];
      if (m[1]) {
        cls = m[2] ? 'token-key' : 'token-string';
        if (m[2]) {
          frag.appendChild(el('span', { 'class': cls, text: m[1] }));
          frag.appendChild(document.createTextNode(m[2]));
          last = re.lastIndex;
          continue;
        }
      } else if (m[3]) {
        cls = m[3] === 'null' ? 'token-null' : 'token-boolean';
      } else {
        cls = 'token-number';
      }
      frag.appendChild(el('span', { 'class': cls, text: text }));
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
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done(true); }, fallback);
    } else {
      fallback();
    }
  }

  function build(root) {
    if (root.getAttribute('data-ready')) return;
    root.textContent = '';
    root.setAttribute('data-ready', '1');

    var state = { fileName: '', result: null, timer: null };

    /* Top bar */
    var fileInput = el('input', { type: 'file', accept: '.csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain', 'class': 'c2j-file' });
    var uploadLabel = el('label', { 'class': 'aptdot-file-upload-btn' }, [fileInput, document.createTextNode('📂 Upload CSV')]);
    var sampleBtn = el('button', { type: 'button', 'class': 'aptdot-tool-btn', text: '🧪 Load sample' });
    var delimSel = select('Delimiter', [['auto', 'Auto-detect'], [',', 'Comma ,'], [';', 'Semicolon ;'], ['\t', 'Tab'], ['|', 'Pipe |']], 'auto');
    var topLeft = el('div', { 'class': 'aptdot-top-left' }, [uploadLabel, sampleBtn, delimSel.wrap]);
    var badge = el('span', { 'class': 'aptdot-privacy-badge', text: '🔒 100% Client-Side (Zero Server Storage)' });
    var topBar = el('div', { 'class': 'aptdot-top-bar' }, [topLeft, el('div', { 'class': 'aptdot-top-right' }, [badge])]);

    /* Editor */
    var gutter = el('div', { 'class': 'aptdot-line-gutter c2j-gutter', 'aria-hidden': 'true', text: '1' });
    var input = el('textarea', {
      'class': 'c2j-input', spellcheck: 'false', wrap: 'off', autocomplete: 'off', autocapitalize: 'off',
      'aria-label': 'CSV input', placeholder: 'Paste CSV here, drag & drop a .csv file, or click "Load sample"...',
      'data-gramm': 'false', 'data-enable-grammarly': 'false'
    });
    var editor = el('div', { 'class': 'aptdot-editor-frame' }, [gutter, input]);

    /* Options */
    var optHeader = checkbox('First row is headers', true, 'Use the first row as JSON keys');
    var optTypes = checkbox('Detect numbers & booleans', true, 'Turn 42, 3.5, true and false into JSON types. Values like 007 stay text.');
    var optConsistent = checkbox('Same type for whole column', true, 'A column becomes numbers only if every value in it is a number, so ZIP codes like 02115 and 98101 both stay text');
    var optJson = checkbox('Parse JSON in cells', true, 'Turn cells like ["a","b"] or {"x":1} back into arrays and objects');
    var optNested = checkbox('Nest dotted headers (address.city)', true, 'Columns like address.city become {"address":{"city":...}}');
    var optTrim = checkbox('Trim spaces', false, 'Remove spaces at the start and end of each value');
    var optUnguard = checkbox('Remove formula guard (\')', false, 'Remove the leading apostrophe that spreadsheets and exporters add before = + - @');
    var emptySel = select('Empty cells', [['string', 'Empty text ""'], ['null', 'null'], ['omit', 'Leave out key']], 'string');
    var outSel = select('Output', [['objects', 'Array of objects'], ['arrays', 'Array of arrays'], ['ndjson', 'JSON Lines (NDJSON)']], 'objects');
    var indentSel = select('Indent', [['2', '2 spaces'], ['4', '4 spaces'], ['tab', 'Tab'], ['0', 'Minified']], '2');

    var convertBtn = el('button', { type: 'button', 'class': 'aptdot-tool-btn aptdot-primary', text: '⚡ Convert to JSON' });
    var clearBtn = el('button', { type: 'button', 'class': 'aptdot-tool-btn aptdot-clear', text: '🗑️ Clear' });

    var toolbar = el('div', { 'class': 'aptdot-bottom-toolbar c2j-toolbar' }, [
      el('div', { 'class': 'aptdot-btn-row' }, [convertBtn, clearBtn]),
      el('div', { 'class': 'c2j-options', role: 'group', 'aria-label': 'Conversion options' }, [
        optHeader.wrap, optTypes.wrap, optConsistent.wrap, optJson.wrap, optNested.wrap, optTrim.wrap, optUnguard.wrap
      ]),
      el('div', { 'class': 'aptdot-dropdown-row' }, [emptySel.wrap, outSel.wrap, indentSel.wrap])
    ]);

    /* Output */
    var output = el('div', { 'class': 'aptdot-output-frame c2j-output', 'aria-live': 'polite' }, [
      el('div', { 'class': 'aptdot-placeholder-text', text: 'Your JSON appears here as soon as you paste or upload CSV.' })
    ]);

    root.appendChild(el('div', { 'class': 'aptdot-tool-wrapper c2j-wrapper' }, [topBar, editor, toolbar, output]));

    /* Behaviour */
    function options() {
      var ind = indentSel.input.value;
      return {
        delimiter: delimSel.input.value,
        header: optHeader.input.checked,
        types: optTypes.input.checked,
        consistent: optConsistent.input.checked,
        jsonCells: optJson.input.checked,
        nested: optNested.input.checked,
        trim: optTrim.input.checked,
        unguard: optUnguard.input.checked,
        empty: emptySel.input.value,
        output: outSel.input.value,
        indent: ind === 'tab' ? '\t' : parseInt(ind, 10)
      };
    }

    function updateGutter() {
      var count = 1;
      var v = input.value;
      for (var i = 0; i < v.length; i++) if (v.charCodeAt(i) === 10) count++;
      var shown = Math.min(count, 20000);
      var parts = [];
      for (var n = 1; n <= shown; n++) parts.push(n);
      gutter.textContent = parts.join('\n');
      gutter.scrollTop = input.scrollTop;
    }

    function showPlaceholder(text) {
      output.textContent = '';
      output.appendChild(el('div', { 'class': 'aptdot-placeholder-text', text: text }));
      state.result = null;
    }

    function render(res) {
      output.textContent = '';
      state.result = res;
      if (!res.ok) {
        var errBox = el('div', { 'class': 'aptdot-report-box c2j-error', role: 'alert' });
        errBox.appendChild(el('strong', { text: '❌ Could not convert this CSV' }));
        for (var e = 0; e < res.errors.length; e++) errBox.appendChild(el('div', { 'class': 'c2j-msg', text: res.errors[e] }));
        output.appendChild(errBox);
        return;
      }
      var opts = options();
      var delimName = DELIM_NAMES[res.stats.delimiter] || ('"' + res.stats.delimiter + '"');
      var stats = res.stats.rows + ' row' + (res.stats.rows === 1 ? '' : 's') + ' · ' + res.stats.columns +
        ' column' + (res.stats.columns === 1 ? '' : 's') + ' · ' + delimName + (res.stats.detected ? ' (auto-detected)' : '');

      var copyBtn = el('button', { type: 'button', 'class': 'aptdot-tool-btn', text: '📋 Copy' });
      var ext = opts.output === 'ndjson' ? 'jsonl' : 'json';
      var dlBtn = el('button', { type: 'button', 'class': 'aptdot-tool-btn', text: '💾 Download .' + ext });
      var header = el('div', { 'class': 'aptdot-panel-header' }, [
        el('div', { 'class': 'c2j-title-wrap' }, [
          el('span', { 'class': 'aptdot-panel-title', text: '✅ JSON output' }),
          el('span', { 'class': 'c2j-stats', text: stats })
        ]),
        el('div', { 'class': 'aptdot-panel-actions' }, [copyBtn, dlBtn])
      ]);
      output.appendChild(header);

      if (res.warnings.length) {
        var box = el('div', { 'class': 'aptdot-report-box c2j-warn' });
        box.appendChild(el('strong', { text: '⚠️ ' + res.warnings.length + ' note' + (res.warnings.length === 1 ? '' : 's') }));
        var list = el('ul', { 'class': 'c2j-list' });
        for (var w = 0; w < res.warnings.length && w < MAX_WARNINGS; w++) list.appendChild(el('li', { text: res.warnings[w] }));
        box.appendChild(list);
        output.appendChild(box);
      }

      var pre = el('pre', { 'class': 'c2j-code', tabindex: '0', 'aria-label': 'JSON output' });
      var code = el('code');
      var lines = res.json.split('\n');
      var text = lines.length > PREVIEW_LINES ? lines.slice(0, PREVIEW_LINES).join('\n') : res.json;
      if (text.length < 400000) renderJson(code, text); else code.textContent = text;
      pre.appendChild(code);
      output.appendChild(pre);
      if (lines.length > PREVIEW_LINES) {
        output.appendChild(el('div', { 'class': 'aptdot-placeholder-text c2j-more',
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
      if (!input.value.replace(/\s+/g, '')) {
        showPlaceholder('Your JSON appears here as soon as you paste or upload CSV.');
        return;
      }
      render(convert(input.value, options()));
    }

    function schedule() {
      if (state.timer) clearTimeout(state.timer);
      if (input.value.length > AUTO_LIMIT) {
        showPlaceholder('Large input: click "Convert to JSON" to convert it.');
        return;
      }
      state.timer = setTimeout(run, 300);
    }

    function readFile(file) {
      if (!file) return;
      state.fileName = file.name || '';
      var reader = new FileReader();
      reader.onload = function () {
        input.value = String(reader.result || '');
        updateGutter();
        run();
      };
      reader.onerror = function () {
        showPlaceholder('That file could not be read.');
      };
      reader.readAsText(file);
    }

    input.addEventListener('input', function () { state.fileName = ''; updateGutter(); schedule(); });
    input.addEventListener('scroll', function () { gutter.scrollTop = input.scrollTop; });
    convertBtn.addEventListener('click', run);
    clearBtn.addEventListener('click', function () {
      input.value = '';
      state.fileName = '';
      updateGutter();
      showPlaceholder('Your JSON appears here as soon as you paste or upload CSV.');
      input.focus();
    });
    sampleBtn.addEventListener('click', function () {
      input.value = SAMPLE;
      state.fileName = 'sample.csv';
      updateGutter();
      run();
    });
    fileInput.addEventListener('change', function () {
      if (fileInput.files && fileInput.files[0]) readFile(fileInput.files[0]);
      fileInput.value = '';
    });
    var controls = [delimSel.input, optHeader.input, optTypes.input, optConsistent.input, optJson.input, optNested.input, optTrim.input,
      optUnguard.input, emptySel.input, outSel.input, indentSel.input];
    for (var i = 0; i < controls.length; i++) {
      controls[i].addEventListener('change', function () { if (input.value) run(); });
    }
    editor.addEventListener('dragover', function (e) { e.preventDefault(); editor.className = 'aptdot-editor-frame aptdot-drag-over'; });
    editor.addEventListener('dragleave', function () { editor.className = 'aptdot-editor-frame'; });
    editor.addEventListener('drop', function (e) {
      e.preventDefault();
      editor.className = 'aptdot-editor-frame';
      var files = e.dataTransfer && e.dataTransfer.files;
      if (files && files[0]) readFile(files[0]);
    });
  }

  function boot() {
    var roots = document.querySelectorAll('.aptdot-csv2json');
    for (var i = 0; i < roots.length; i++) build(roots[i]);
  }

  // Exposed for automated tests; not used by the page.
  window.AptdotCsvToJson = {
    parseCsv: parseCsv, detectDelimiter: detectDelimiter, convert: convert, convertValue: convertValue,
    sample: SAMPLE
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
