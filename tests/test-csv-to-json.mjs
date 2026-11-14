// Tests for assets/js/csv-to-json.js
// Usage: node tests/test-csv-to-json.mjs [csv-to-json.js] [json-formatter.js] [node_modules dir] [fuzz-cases.json]
// With no arguments it uses the repository layout (src/, node_modules/, tests/).
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const [, , enginePath = 'src/csv-to-json.js', jsonEnginePath = 'src/json-formatter.js', nm = 'node_modules', fuzzPath = 'tests/fuzz-cases.json'] = process.argv;
const require = createRequire(path.join(path.resolve(nm), 'x.js'));
const { JSDOM } = require('jsdom');
const acorn = require('acorn');

const src = fs.readFileSync(enginePath, 'utf8');
let pass = 0, fail = 0;
const failures = [];
const ok = (cond, name) => { if (cond) pass++; else { fail++; failures.push(name); } };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function load(html = '<div class="aptdot-csv2json"></div>', extraScripts = []) {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { runScripts: 'outside-only', pretendToBeVisual: true });
  for (const s of extraScripts) dom.window.eval(s);
  dom.window.eval(src);
  return dom;
}

// 0. Static checks
acorn.parse(src, { ecmaVersion: 5 });
ok(true, 'ES5 syntax');
ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/.test(src.replace(/\/\*[\s\S]*?\*\//g, '')), 'No HTML-string APIs or eval');
ok(!/fetch\(|XMLHttpRequest|localStorage|sessionStorage|document\.cookie|sendBeacon/.test(src), 'No network or storage APIs');

const dom = load();
const E = dom.window.AptdotCsvToJson;
const base = { delimiter: 'auto', header: true, types: true, consistent: true, jsonCells: true, nested: true, trim: false, unguard: false, empty: 'string', output: 'objects', indent: 2 };
const conv = (text, o = {}) => E.convert(text, Object.assign({}, base, o));

// 0b. Library defaults: convert(text) behaves like the page's initial settings
{
  const t = 'id,name,zip,active\n1,"Nair, Priya",02115,true\n2,Liam,98101,false\n';
  ok(E.convert(t).json === conv(t).json && E.convert(t, null).json === conv(t).json, 'convert(text) uses the page defaults');
  ok(eq(E.convert(t).data[1], { id: 2, name: 'Liam', zip: '98101', active: false }), 'Default output types a whole column consistently');
  ok(E.convert('sep=;\na;b\n1;2').stats.delimiter === ';' && E.convert('sep=;\na;b\n1;2', { delimiter: undefined }).stats.delimiter === ';', 'sep= hint honoured with no delimiter given');
  ok(E.convert(t, { header: false }).data.length === 3 && E.convert(t, { types: false }).data[0].id === '1', 'Single options override defaults');
}

// 1. Fuzz: parser vs Python csv module (explicit delimiter), and auto-detection
const cases = JSON.parse(fs.readFileSync(fuzzPath, 'utf8'));
let parseMismatch = 0, detectChecked = 0, detectWrong = 0;
for (const c of cases) {
  const r = E.parseCsv(c.csv, c.delimiter);
  const rows = r.rows.filter(row => !(row.length === 1 && row[0] === ''));
  const expected = c.rows.filter(row => !(row.length === 1 && row[0] === ''));
  if (r.errors.length || !eq(rows, expected)) { parseMismatch++; if (parseMismatch <= 3) failures.push('fuzz mismatch: ' + JSON.stringify(c.csv).slice(0, 120)); }
  if (c.ncols >= 2 && c.rows.length >= 2) {
    detectChecked++;
    if (E.detectDelimiter(c.csv) !== c.delimiter) detectWrong++;
  }
}
ok(parseMismatch === 0, `Parser matches Python csv on ${cases.length} fuzz cases (${parseMismatch} mismatches)`);
ok(detectWrong / detectChecked < 0.03, `Delimiter auto-detect correct on ${detectChecked - detectWrong}/${detectChecked} multi-column cases`);
console.log(`  fuzz: ${cases.length} cases, ${parseMismatch} parse mismatches; detection ${detectChecked - detectWrong}/${detectChecked}`);

// 2. Round trip through the Aptdot JSON to CSV engine (v2)
const jdom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only' });
jdom.window.eval(fs.readFileSync(jsonEnginePath, 'utf8'));
const jsonToCsv = jdom.window.AptdotJsonSuite.jsonToCsv;
let seed = 7;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const pick = a => a[Math.floor(rnd() * a.length)];
const words = ['alpha', 'Beta gamma', 'with, comma', 'quote "here"', 'line\nbreak', 'crlf\r\nbreak', 'naïve', '日本語', '😀', '=SUM(A1)', '-dash', '+plus', '@at', "it's", ' padded ', 'a|b', 'x;y', 'tab\there'];
function value(depth) {
  const r = rnd();
  if (r < 0.25) return pick(words);
  if (r < 0.45) return Math.round(rnd() * 1e6) / (rnd() < 0.5 ? 1 : 100) * (rnd() < 0.2 ? -1 : 1);
  if (r < 0.55) return rnd() < 0.5;
  if (r < 0.62) return null;
  if (r < 0.8 && depth < 2) { const o = {}; for (let i = 0; i < 1 + Math.floor(rnd() * 3); i++) o[pick(['k', 'city', 'n', 'deep'])] = value(depth + 1); return o; }
  if (depth < 2) { const a = []; for (let i = 0; i < Math.floor(rnd() * 3); i++) a.push(value(depth + 1)); return a; }
  return pick(words);
}
let rtFail = 0;
for (let t = 0; t < 300; t++) {
  const keys = ['id', 'name', 'meta', 'tags', 'Price (USD)', 'émoji 😀', '__proto__'].slice(0, 2 + Math.floor(rnd() * 6));
  const recs = [];
  for (let i = 0; i < 1 + Math.floor(rnd() * 5); i++) {
    const o = {};
    for (const k of keys) Object.defineProperty(o, k, { value: value(0), enumerable: true, writable: true, configurable: true });
    recs.push(o);
  }
  const csv = jsonToCsv(JSON.parse(JSON.stringify(recs)));
  const res = conv(csv, { nested: false, empty: 'null', unguard: true, consistent: false });
  if (!res.ok || res.data.length !== recs.length || JSON.stringify(res.data) !== JSON.stringify(recs)) {
    rtFail++;
    if (rtFail <= 3) failures.push('round trip: ' + JSON.stringify(recs).slice(0, 200) + ' => ' + (res.ok ? JSON.stringify(res.data).slice(0, 200) : res.errors.join(';')));
  }
}
ok(rtFail === 0, `JSON → CSV (Aptdot engine) → JSON round trip is exact on 300 random datasets (${rtFail} failures)`);
ok(dom.window.Object.prototype.polluted === undefined && ({}).polluted === undefined, 'No prototype pollution after __proto__ columns');

// 3. Edge cases
let r;
r = conv('﻿a,b\n1,2'); ok(r.ok && eq(r.data, [{ a: 1, b: 2 }]), 'BOM is removed');
r = conv('sep=;\na;b\n1;2'); ok(r.ok && eq(r.data, [{ a: 1, b: 2 }]) && r.stats.delimiter === ';', 'Excel sep=; hint honoured and removed');
r = conv('a;b;c\n1;2;3\n4;5;6'); ok(r.stats.delimiter === ';' && r.stats.detected, 'Semicolon auto-detected');
r = conv('a\tb\n1\t2'); ok(r.stats.delimiter === '\t', 'Tab auto-detected');
r = conv('a|b\n1|2'); ok(r.stats.delimiter === '|', 'Pipe auto-detected');
r = conv('name,note\n"Smith, J","He said ""hi"""'); ok(eq(r.data, [{ name: 'Smith, J', note: 'He said "hi"' }]), 'Quoted commas and doubled quotes');
r = conv('a,b\n"line1\r\nline2",x'); ok(r.data[0].a === 'line1\r\nline2', 'CRLF inside a quoted value is kept');
r = conv('a,b\r\n1,2\r\n3,4\r\n'); ok(r.data.length === 2, 'CRLF line endings, trailing newline');
r = conv('a,b\r1,2\r3,4'); ok(r.data.length === 2, 'Old Mac CR line endings');
r = conv('a,b\n"open,1\n2,3'); ok(!r.ok && /line 2, column 1/.test(r.errors[0]), 'Unclosed quote reported with line and column');
r = conv('a,b\n1,he said "x" ok\n'); ok(r.ok && r.data[0].b === 'he said "x" ok' && r.warnings.length >= 1, 'Stray quote kept with a warning');
r = conv('a,b,c\n1,2\n3,4,5,6'); ok(eq(r.data[0], { a: 1, b: 2, c: '' }) && eq(r.data[1]._extra, [6]) && r.warnings.some(w => /Line 2 has 2 values/.test(w)), 'Ragged rows: missing → empty, extra → _extra, with line numbers');
r = conv('id,name,name,\n1,a,b,c'); ok(eq(Object.keys(r.data[0]), ['id', 'name', 'name_2', 'column_4']), 'Duplicate and empty headers renamed');
r = conv('id,zip,big,price,precise,neg,plus,dot,exp\n007,02115,12345678901234567890,9.99,0.12345678901234567,-5,+5,.5,1e3', { consistent: false });
ok(eq(r.data[0], { id: '007', zip: '02115', big: '12345678901234567890', price: 9.99, precise: '0.12345678901234567', neg: -5, plus: '+5', dot: '.5', exp: 1000 }), 'Number detection keeps leading zeros, big integers and over-precise decimals as text');
r = conv('zip,qty,flag\n02115,1,true\n98101,2,false\n,3,'); ok(eq(r.data, [{ zip: '02115', qty: 1, flag: true }, { zip: '98101', qty: 2, flag: false }, { zip: '', qty: 3, flag: '' }]), 'Same type for whole column: ZIPs stay text, qty numbers, flags booleans');
r = conv('mix\n1\ntrue\nabc'); ok(eq(r.data.map(o => o.mix), ['1', 'true', 'abc']), 'Mixed column stays text');
r = conv('n\n1\n2.5\n-3'); ok(eq(r.data.map(o => o.n), [1, 2.5, -3]), 'All-number column becomes numbers');
r = conv('a,b,c,d,e\ntrue,FALSE,True,null,NULL'); ok(eq(r.data[0], { a: true, b: false, c: true, d: null, e: 'NULL' }), 'Booleans and null detected');
r = conv('a,b\n1,true', { types: false }); ok(eq(r.data[0], { a: '1', b: 'true' }), 'Type detection can be turned off');
r = conv('a,b\n"{""x"":1}","[1,2]"'); ok(eq(r.data[0], { a: { x: 1 }, b: [1, 2] }), 'JSON inside cells parsed');
r = conv('a,b\n"{not json}","[oops"'); ok(eq(r.data[0], { a: '{not json}', b: '[oops' }), 'Invalid JSON in cells stays text');
r = conv('a\n"[1,2]"', { jsonCells: false }); ok(r.data[0].a === '[1,2]', 'JSON cells can be turned off');
r = conv('id,address.city,address.geo.lat\n1,London,51.5'); ok(eq(r.data[0], { id: 1, address: { city: 'London', geo: { lat: 51.5 } } }), 'Dotted headers become nested objects');
r = conv('address,address.city\nx,London'); ok(eq(r.data[0], { address: 'x', 'address.city': 'London' }) && r.warnings.length >= 1, 'Nested header clash kept flat with a warning');
r = conv('a.b,a.b.c\n1,2'); ok(eq(r.data[0], { 'a.b': 1, 'a.b.c': 2 }) || eq(r.data[0], { a: { b: 1 }, 'a.b.c': 2 }), 'Leaf/prefix clash does not lose data');
r = conv('a..b,.c,d.\n1,2,3'); ok(eq(r.data[0], { 'a..b': 1, '.c': 2, 'd.': 3 }), 'Malformed dotted headers stay flat');
r = conv('v1.2,x\n1,2', { nested: false }); ok(eq(Object.keys(r.data[0]), ['v1.2', 'x']), 'Nesting can be turned off');
r = conv('__proto__.polluted,constructor.prototype.bad,x\n1,2,3'); ok(r.ok && ({}).polluted === undefined && dom.window.eval('({}).polluted') === undefined && dom.window.eval('({}).bad') === undefined, 'Dangerous dotted headers cannot pollute prototypes');
r = conv('__proto__,constructor,id\n1,2,3'); ok(r.ok && r.json.indexOf('"__proto__": 1') > -1 && r.json.indexOf('"constructor": 2') > -1, 'Columns named __proto__ and constructor are kept as data');
r = conv('__proto__.x,id\n1,2'); ok(r.json.indexOf('"__proto__": {') > -1, 'Nested __proto__ header kept as data');
r = conv('a,b\n,x', { empty: 'null' }); ok(eq(r.data[0], { a: null, b: 'x' }), 'Empty → null');
r = conv('a,b\n,x', { empty: 'omit' }); ok(eq(r.data[0], { b: 'x' }), 'Empty → key left out');
r = conv('a,b\n  x  ,y', { trim: true }); ok(r.data[0].a === 'x', 'Trim option');
r = conv('a\n  x  '); ok(r.data[0].a === '  x  ', 'Spaces kept by default');
r = conv("a,b\n'=SUM(A1),'-5", { unguard: true, types: true }); ok(r.data[0].a === '=SUM(A1)' && r.data[0].b === -5, 'Formula guard removal');
r = conv('a,b\n1,2', { header: false, consistent: false }); ok(eq(r.data, [['a', 'b'], [1, 2]]), 'No header → array of arrays');
r = conv('a,b\n1,2', { header: false }); ok(eq(r.data, [['a', 'b'], ['1', '2']]), 'No header + same type per column: mixed columns stay text');
r = conv('a,b\n1,2\n3,4', { output: 'arrays' }); ok(eq(r.data, [['a', 'b'], [1, 2], [3, 4]]), 'Array of arrays output');
r = conv('a,b\n1,2\n3,4', { output: 'ndjson' }); ok(r.json === '{"a":1,"b":2}\n{"a":3,"b":4}', 'NDJSON output');
r = conv('a,b\n1,2', { indent: 0 }); ok(r.json === '[{"a":1,"b":2}]', 'Minified output');
r = conv('a,b\n1,2', { indent: '\t' }); ok(r.json.indexOf('\n\t{') > -1, 'Tab indent');
r = conv('a,b'); ok(r.ok && eq(r.data, []) && r.warnings.some(w => /Only a header/.test(w)), 'Header only → [] with a note');
r = conv('   \n  '); ok(!r.ok, 'Empty input → message, no output');
r = conv('a,b\n1,2\n\n3,4\n'); ok(r.data.length === 2 && r.warnings.some(w => /blank line/.test(w)), 'Blank lines skipped and reported');
r = conv('a\n""'); ok(eq(r.data, [{ a: '' }]), 'A quoted empty value is a real row');
r = conv('single\nvalue'); ok(eq(r.data, [{ single: 'value' }]), 'Single column file');
r = conv('a,b\n1,2', { delimiter: ';' }); ok(eq(r.data, [{ 'a,b': '1,2' }]), 'Manual delimiter overrides detection');
const big = 'id,name,score\n' + Array.from({ length: 50000 }, (_, i) => `${i},"Name ${i}, Jr",${(i * 1.5).toFixed(1)}`).join('\n');
const t0 = Date.now(); r = conv(big); const ms = Date.now() - t0;
ok(r.ok && r.data.length === 50000 && r.data[49999].name === 'Name 49999, Jr', `50,000 rows convert correctly (${ms} ms)`);
ok(ms < 3000, '50,000 rows convert in under 3 seconds');

// 4. UI in a DOM, including hostile input
const ui = load('<div class="aptdot-csv2json"></div><div class="aptdot-csv2json"></div>');
await new Promise(res => ui.window.document.readyState === 'loading' ? ui.window.addEventListener('DOMContentLoaded', () => setTimeout(res, 0)) : res());
const doc = ui.window.document;
const roots = doc.querySelectorAll('.aptdot-csv2json');
ok([...roots].every(n => n.getAttribute('data-ready') === '1' && n.querySelector('textarea.c2j-input')), 'Two tools on one page both start');
const root = roots[0];
const btn = (t) => [...root.querySelectorAll('button')].find(b => b.textContent.indexOf(t) > -1);
btn('Load sample').click();
await new Promise(res => setTimeout(res, 20));
const statText = (root.querySelector('.c2j-stats') || {}).textContent || '';
ok(/3 rows · 9 columns · comma \(auto-detected\)/.test(statText), 'Sample converts: ' + statText);
const out = root.querySelector('.c2j-code').textContent;
const parsedOut = JSON.parse(out);
ok(parsedOut[0].zip === '02115' && parsedOut[0].address.city === 'London' && eq(parsedOut[0].tags, ['admin', 'editor']) && parsedOut[1].notes === 'Line one\nline two' && parsedOut[2].zip === '98101' && parsedOut[0].id === 1 && parsedOut[2].active === true, 'Sample output is correct');
ok(root.querySelectorAll('.c2j-code span.token-key').length > 0, 'Output is highlighted');
const ta = root.querySelector('textarea.c2j-input');
ta.value = '<img src=x onerror="window.__pwned=1">,"<script>window.__pwned=2</script>"\n"<svg onload=window.__pwned=3>",x';
ta.dispatchEvent(new ui.window.Event('input', { bubbles: true }));
await new Promise(res => setTimeout(res, 400));
ok(ui.window.__pwned === undefined && root.querySelectorAll('img, script, svg').length === 0 && /onerror/.test(root.querySelector('.c2j-code').textContent), 'Hostile CSV is shown as text only');
ta.value = 'a,b\n"broken,1';
ta.dispatchEvent(new ui.window.Event('input', { bubbles: true }));
await new Promise(res => setTimeout(res, 400));
ok(/never closed/.test(root.querySelector('.c2j-error').textContent), 'Error box for an unclosed quote');
const sel = [...root.querySelectorAll('select')].find(s => [...s.options].some(o => o.value === 'ndjson'));
ta.value = 'a,b\n1,2\n3,4'; ta.dispatchEvent(new ui.window.Event('input', { bubbles: true }));
await new Promise(res => setTimeout(res, 400));
sel.value = 'ndjson'; sel.dispatchEvent(new ui.window.Event('change', { bubbles: true }));
ok(root.querySelector('.c2j-code').textContent === '{"a":1,"b":2}\n{"a":3,"b":4}' && /Download \.jsonl/.test(root.textContent), 'Changing an option re-converts (NDJSON, .jsonl download)');
ok([...root.querySelectorAll('select, input[type=checkbox]')].every(c => c.id && root.querySelector(`label[for="${c.id}"]`)), 'Every control has a label');
btn('Clear').click();
ok(ta.value === '' && root.querySelector('.aptdot-placeholder-text'), 'Clear empties input and output');

console.log(`${pass} passed, ${fail} failed`);
if (fail) { console.log(failures.map(f => '  - ' + f).join('\n')); process.exit(1); }
