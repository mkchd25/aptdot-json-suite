// Tests for the YAML to JSON converter.
// Usage: node tests/test-yaml-to-json.mjs [yaml-to-json.js] [vendor/yaml.min.js] [json-formatter.js] [node_modules] [corpus.json]
// With no arguments it uses the repository layout.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const [, , enginePath = 'src/yaml-to-json.js', vendorPath = 'src/vendor/yaml.min.js', jsonEnginePath = 'src/json-formatter.js',
  nm = 'node_modules', corpusPath = 'tests/yaml-corpus.json'] = process.argv;
const require = createRequire(path.join(path.resolve(nm), 'x.js'));
const { JSDOM } = require('jsdom');
const jsyaml = require('js-yaml');
const YAML = require('yaml');
const acorn = require('acorn');

let pass = 0, fail = 0;
const failures = [];
const ok = (cond, name) => { if (cond) pass++; else { fail++; failures.push(name); } };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return Number.isNaN(a) && Number.isNaN(b);
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  if (typeof a !== 'object') return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every(k => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
}

const engineSrc = fs.readFileSync(enginePath, 'utf8');
const vendorSrc = fs.readFileSync(vendorPath, 'utf8');

// 0. Engine is plain ES5 and makes no network or storage calls
let es5 = true;
try { acorn.parse(engineSrc, { ecmaVersion: 5 }); } catch (e) { es5 = false; }
ok(es5, 'Engine parses as ES5');
ok(!/fetch\(|XMLHttpRequest|sendBeacon|localStorage|sessionStorage|document\.cookie|innerHTML|eval\(|new Function/.test(engineSrc), 'Engine: no network, storage, innerHTML or eval');
ok(!/fetch\(|XMLHttpRequest|sendBeacon|localStorage|sessionStorage|document\.cookie|eval\(|new Function/.test(vendorSrc), 'Vendor parser: no network, storage or eval');
ok(/Permission to use, copy, modify, and\/or distribute this software/.test(vendorSrc.slice(0, 2000)), 'Vendor parser keeps its ISC licence notice');

const dom = new JSDOM('<body></body>', { runScripts: 'outside-only' });
dom.window.eval(vendorSrc);
dom.window.eval(engineSrc);
const E = dom.window.AptdotYamlToJson;
const conv = (s, o) => E.convert(s, o);
const val = (s, o) => { const r = conv(s, o); if (!r.ok) throw new Error(r.errors.join('; ')); return JSON.parse(r.json); };
const json = (s, o) => conv(s, o).json;

// 1. YAML 1.2 rules, exact numbers, data safety
ok(eq(val('c: NO\nb: yes\no: on\nn: no\nd: 2026-11-20'), { c: 'NO', b: 'yes', o: 'on', n: 'no', d: '2026-11-20' }), 'YAML 1.2: NO/yes/on/no and dates stay text');
ok(eq(val('t: true\nf: false\nn: null\nm: ~\ne:'), { t: true, f: false, n: null, m: null, e: null }), 'Booleans and nulls');
ok(eq(val('zip: 02115\nmode: 0644\nneg: -012\nzero: 0'), { zip: '02115', mode: '0644', neg: '-012', zero: 0 }), 'Leading zeros kept as text by default');
ok(eq(val('zip: 02115', { leadingZeros: 'number' }), { zip: 2115 }), 'Leading zeros: number follows YAML 1.2');
ok(json('a: 1.10\nb: 1e3\nc: 1E+3', { indent: 0 }) === '{"a":1.10,"b":1e3,"c":1E+3}', 'Numbers written exactly as in the YAML');
ok(json('id: 12345678901234567890\nn: -98765432109876543210', { indent: 0 }) === '{"id":12345678901234567890,"n":-98765432109876543210}', 'Large integers keep every digit');
ok(conv('id: 12345678901234567890').warnings.some(w => /too large for JavaScript/.test(w)), 'Large integers produce a note');
ok(eq(val('id: 12345678901234567890', { bigIntegers: 'text' }), { id: '12345678901234567890' }), 'Large integers: text');
ok(eq(val('a: +5\nb: .5\nc: 0x1F\nd: 0o17\ne: -0.5'), { a: 5, b: 0.5, c: 31, d: 15, e: -0.5 }), 'YAML-only number forms become valid JSON numbers');
ok(json('a: .inf\nb: -.Inf\nc: .nan', { indent: 0 }) === '{"a":null,"b":null,"c":null}' && conv('a: .inf').warnings.some(w => /cannot be written in JSON/.test(w)), 'Infinity/NaN become null with a note');
ok(eq(val('a: "02115"\nb: \'NO\'\nc: "1.10"'), { a: '02115', b: 'NO', c: '1.10' }), 'Quoted values stay text');
ok(eq(val('a: "line\\nbreak"\nb: \'it\'\'s\'\nc: |\n  keep\n  lines\nd: >\n  fold\n  this\ne: |-\n  no newline'), { a: 'line\nbreak', b: "it's", c: 'keep\nlines\n', d: 'fold this\n', e: 'no newline' }), 'Quoted, literal and folded strings');
ok(eq(val('name: Zoë 日本 😀\n"quoted key": "\\u00e9"'), { name: 'Zoë 日本 😀', 'quoted key': 'é' }), 'Unicode and escapes');

// 1b. Integers are exact at any size and in any notation (review fixes)
const validJson = (s, o) => { try { JSON.parse(conv(s, o).json); return true; } catch (e) { return false; } };
ok(json('id: 012345678901234567890', { leadingZeros: 'number', indent: 0 }) === '{"id":12345678901234567890}' && validJson('id: 012345678901234567890', { leadingZeros: 'number' }), 'Large leading-zero integer in number mode is valid JSON');
ok(json('a: 0x1e00000000000000\nb: 0o7777777777777777777777', { indent: 0 }) === '{"a":2161727821137838080,"b":73786976294838206463}', 'Large hex and octal integers are exact');
ok(json('a: !!int "12345678901234567890"', { indent: 0 }) === '{"a":12345678901234567890}', '!!int "..." keeps every digit');
ok(json('a: 1' + '0'.repeat(309), { indent: 0 }) === '{"a":1' + '0'.repeat(309) + '}', 'Integers longer than 308 digits are exact, not null');
ok(eq(val('a: 0o7777777777777777777777', { bigIntegers: 'text' }), { a: '73786976294838206463' }), 'Large integers: text gives exact decimal digits');
ok(eq(val('%YAML 1.1 # legacy\n---\na: yes'), { a: true }) && eq(val('%YAML 1.1\r\n---\r\na: yes\r\n'), { a: true }), '%YAML 1.1 detected with a comment and with Windows line endings');
ok(!conv('*missing : 123').ok && /does not match any anchor/.test(conv('*missing : 123').errors[0]), 'Unresolved alias used as a key: clear error');
ok(!conv('a: &a { *a : 1 }').ok && /refers to the value that contains it/.test(conv('a: &a { *a : 1 }').errors[0]), 'Self-referencing alias used as a key: clear error');
ok(eq(val('k: &k name\nm: { *k : 1 }'), { k: 'name', m: { name: 1 } }), 'Alias used as a key');

// 2. Structure
ok(json('b: 1\n2: x\n1: y\na: 2', { indent: 0 }) === '{"b":1,"2":"x","1":"y","a":2}', 'Key order kept exactly, including numeric keys');
ok(eq(val('base: &b {x: 1, y: 0}\nd:\n  <<: *b\n  y: 2'), { base: { x: 1, y: 0 }, d: { x: 1, y: 2 } }), 'Merge key: explicit keys override');
ok(eq(val('a: &a {x: 1}\nb: &b {x: 2, y: 2}\nc:\n  <<: [*a, *b]\n  z: 3'), { a: { x: 1 }, b: { x: 2, y: 2 }, c: { x: 1, y: 2, z: 3 } }), 'Merge list: earlier sources win');
ok(eq(val('b: &b {x: 1}\nd: {<<: *b}', { merge: false }), { b: { x: 1 }, d: { '<<': { x: 1 } } }), 'Merge keys can be turned off');
ok(eq(val('a: &a [1, 2]\nb: *a\nc: &c {k: v}\nd: *c'), { a: [1, 2], b: [1, 2], c: { k: 'v' }, d: { k: 'v' } }), 'Anchors and aliases');
ok(eq(val('s: !!set {a, b}\no: !!omap [{a: 1}, {b: 2}]'), { s: { a: null, b: null }, o: [{ a: 1 }, { b: 2 }] }), 'Sets and ordered maps keep their contents');
ok(eq(val('b: !!binary aGVsbG8=\nt: !!timestamp 2026-01-01T10:00:00Z\ns: !!str 123'), { b: 'aGVsbG8=', t: '2026-01-01T10:00:00Z', s: '123' }), 'Explicit !!binary, !!timestamp and !!str');
ok(eq(val('1: a\ntrue: b\nnull: c\n1.10: d'), { 1: 'a', true: 'b', null: 'c', '1.10': 'd' }), 'Non-text keys written as written');
ok(eq(val('[1, 2]: e'), { '[1,2]': 'e' }) && conv('[1, 2]: e').warnings.some(w => /JSON keys must be text/.test(w)), 'Complex keys become JSON text with a note');
ok(eq(val('a: {}\nb: []\nc:\nd: ""'), { a: {}, b: [], c: null, d: '' }), 'Empty collections, empty values');
ok(eq(val('hello'), 'hello') && eq(val('~'), null) && eq(val('- 1\n- two'), [1, 'two']), 'Top-level scalars and lists');

// 3. Tags
ok(eq(val('R: !Ref Bucket\nG: !GetAtt MyDB.Endpoint.Address\nS: !Sub "${AWS::Region}-x"\nJ: !Join ["-", [a, b]]\nI: !If [C, !Ref A, !Ref "AWS::NoValue"]\nG2: !GetAtt [A, Arn]'),
  { R: { Ref: 'Bucket' }, G: { 'Fn::GetAtt': ['MyDB', 'Endpoint.Address'] }, S: { 'Fn::Sub': '${AWS::Region}-x' }, J: { 'Fn::Join': ['-', ['a', 'b']] },
    I: { 'Fn::If': ['C', { Ref: 'A' }, { Ref: 'AWS::NoValue' }] }, G2: { 'Fn::GetAtt': ['A', 'Arn'] } }), 'CloudFormation tags become their JSON forms');
ok(eq(val('job: !reference [.setup, script]'), { job: { '!reference': ['.setup', 'script'] } }), 'Other custom tags kept as a key');
ok(eq(val('r: !Ref B', { tags: 'key' }), { r: { '!Ref': 'B' } }) && eq(val('r: !Ref B', { tags: 'drop' }), { r: 'B' }), 'Tag modes: key, drop');

// 4. Errors and safety
const dup = conv('a: 1\nb: 2\na: 3');
ok(!dup.ok && /line 3, column 1/.test(dup.errors[0]), 'Duplicate keys: error with line and column');
ok(eq(val('a: 1\nb: 2\na: 3', { duplicates: 'last' }), { a: 3, b: 2 }), 'Duplicate keys: last one wins');
ok(!conv('a: [1, 2\nb: 3').ok && /line 2/.test(conv('a: [1, 2\nb: 3').errors[0]), 'Syntax error shows its position');
ok(!conv('a:\n\tb: 1').ok && /Tabs/.test(conv('a:\n\tb: 1').errors[0]), 'Tab indentation explained');
ok(!conv('a: &a [1, *a]').ok && /refers to the value that contains it/.test(conv('a: &a [1, *a]').errors[0]), 'Self-referencing alias stopped');
let bomb = 'a: &a [x,x,x,x,x,x,x,x,x,x]\n';
for (const [n, p] of [['b', 'a'], ['c', 'b'], ['d', 'c'], ['e', 'd'], ['f', 'e'], ['g', 'f'], ['h', 'g']]) bomb += `${n}: &${n} [${Array(10).fill('*' + p).join(',')}]\n`;
let t0 = Date.now();
const bombRes = conv(bomb);
ok(!bombRes.ok && /alias bomb/.test(bombRes.errors[0]) && Date.now() - t0 < 10000, 'Alias bomb stopped quickly (' + (Date.now() - t0) + ' ms)');
ok(!conv('').ok && !conv('# only\n# comments').ok, 'Empty input explained');
const proto = val('__proto__: {polluted: 1}\nconstructor: 2\ntoString: 3');
ok(dom.window.Object.prototype.polluted === undefined && ({}).polluted === undefined && Object.keys(proto).length === 3, 'No prototype pollution; __proto__ kept as data');
const hostile = val('x: "<img src=x onerror=alert(1)>"\n"<script>": 1');
ok(hostile.x === '<img src=x onerror=alert(1)>' && hostile['<script>'] === 1, 'HTML in YAML stays text');

// 5. Documents and YAML 1.1
ok(eq(val('---\na: 1\n---\nb: 2\n---\n'), [{ a: 1 }, { b: 2 }]), 'Multiple documents become an array; trailing --- skipped');
ok(eq(val('a: 1\n---\n~\n---\nb: 2'), [{ a: 1 }, null, { b: 2 }]), 'An explicit null document is kept');
ok(json('a: 1\n---\nb: 2', { documents: 'jsonl' }) === '{"a":1}\n{"b":2}', 'JSON Lines output');
ok(eq(val('a: 1\n---\nb: 2', { documents: 'first' }), { a: 1 }), 'First document only');
ok(eq(val('%YAML 1.1\n---\na: yes\nb: off\nc: 1:30'), { a: true, b: false, c: 90 }) && conv('%YAML 1.1\n---\nc: 1:30').warnings.some(w => /base-60/.test(w)), 'YAML 1.1 files follow YAML 1.1 rules, with notes');
ok(json('a: {b: [1, {c: 2}]}', { indent: 4 }) === JSON.stringify({ a: { b: [1, { c: 2 }] } }, null, 4), 'Indent 4 matches JSON.stringify');
ok(json('a: {b: [1, {c: 2}]}', { indent: '\t' }) === JSON.stringify({ a: { b: [1, { c: 2 }] } }, null, '\t'), 'Tab indent matches JSON.stringify');
ok(json('\uFEFFa: 1', { indent: 0 }) === '{"a":1}', 'Byte-order mark ignored');

// 6. Real-world files: same result as js-yaml (an independent parser)
const corpus = JSON.parse(fs.readFileSync(corpusPath, 'utf8'));
const jsyamlSchema = jsyaml.CORE_SCHEMA.extend({ implicit: [jsyaml.types.merge] });
let corpusOk = 0;
for (const [name, text] of Object.entries(corpus)) {
  const mine = val(text);
  const all = jsyaml.loadAll(text, null, { schema: jsyamlSchema }).filter(d => d !== null && d !== undefined);
  const theirs = JSON.parse(JSON.stringify(all.length === 1 ? all[0] : all));
  if (deepEqual(mine, theirs)) corpusOk++; else failures.push('corpus mismatch: ' + name);
}
ok(corpusOk === Object.keys(corpus).length, `Real-world YAML (${corpusOk}/${Object.keys(corpus).length}) matches js-yaml`);

// 7. Random data: YAML written by two different libraries converts back exactly
let seed = 7;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const POOL = ['yes', 'no', 'NO', 'on', 'off', 'true', 'null', '~', '', ' ', '02115', '0644', '1.10', '1e3', '0x1F', '-', '- x', 'a: b', '#hash', '&anchor',
  '*alias', '!tag', '%x', '@x', '`x`', '"q"', "'q'", 'line\nbreak', 'tab\there', 'trailing ', ' leading', 'Zoë', '日本', '😀', '{x}', '[x]', '<<', '---', '...', 'NaN', '.inf', 'ʼ'];
function rv(depth) {
  const r = rnd();
  if (depth > 3 || r < 0.45) {
    const k = Math.floor(rnd() * 7);
    if (k === 0) return POOL[Math.floor(rnd() * POOL.length)];
    if (k === 1) return Math.floor(rnd() * 2e6) - 1e6;
    if (k === 2) return Math.round(rnd() * 1e6) / 1e3;
    if (k === 3) return rnd() < 0.5;
    if (k === 4) return null;
    if (k === 5) return 'w' + Math.floor(rnd() * 1e9);
    return (rnd() * 1e-7);
  }
  if (r < 0.7) { const a = []; for (let i = 0, n = Math.floor(rnd() * 5); i < n; i++) a.push(rv(depth + 1)); return a; }
  const o = {};
  for (let i = 0, n = Math.floor(rnd() * 5); i < n; i++) o[rnd() < 0.3 ? POOL[Math.floor(rnd() * POOL.length)] + i : 'k' + Math.floor(rnd() * 100)] = rv(depth + 1);
  return o;
}
let rtOk = 0, rtN = 0, rtSkipped = 0;
const firstBad = [];
for (let i = 0; i < 1500; i++) {
  const v = rv(0);
  const plainV = JSON.parse(JSON.stringify(v));
  for (const [lib, text] of [['yaml', YAML.stringify(v)], ['js-yaml', jsyaml.dump(v)]]) {
    // Skip YAML that the writing library cannot read back itself (js-yaml writes the
    // text "..." unquoted, which YAML reads as an end-of-document marker).
    const self = lib === 'yaml' ? YAML.parse(text) : jsyaml.load(text);
    if (!deepEqual(JSON.parse(JSON.stringify(self === undefined ? null : self)), plainV)) { rtSkipped++; continue; }
    rtN++;
    let back;
    try { back = val(text); } catch (e) { back = { error: e.message }; }
    if (deepEqual(back, JSON.parse(JSON.stringify(v)))) rtOk++; else if (firstBad.length < 3) firstBad.push(lib + ': ' + JSON.stringify(v).slice(0, 150) + ' => ' + JSON.stringify(back).slice(0, 150));
  }
}
ok(rtOk === rtN && rtSkipped < 10, `Round trip of YAML written by two libraries: ${rtOk}/${rtN} (${rtSkipped} skipped: the writer could not read its own output)` + (firstBad.length ? '\n    ' + firstBad.join('\n    ') : ''));

// 8. Round trip with the site's own JSON to YAML converter
const jdom = new JSDOM('<body></body>', { runScripts: 'outside-only' });
jdom.window.eval(fs.readFileSync(jsonEnginePath, 'utf8'));
const jsonToYaml = jdom.window.AptdotJsonSuite.jsonToYaml;
let siteOk = 0;
const siteBad = [];
for (let i = 0; i < 1000; i++) {
  const v = rv(0);
  let back;
  try { back = val(jsonToYaml(JSON.parse(JSON.stringify(v)))); } catch (e) { back = { error: e.message }; }
  if (deepEqual(back, JSON.parse(JSON.stringify(v)))) siteOk++; else if (siteBad.length < 3) siteBad.push(JSON.stringify(v).slice(0, 150) + ' => ' + JSON.stringify(back).slice(0, 150));
}
ok(siteOk === 1000, `Round trip with Aptdot JSON to YAML: ${siteOk}/1000` + (siteBad.length ? '\n    ' + siteBad.join('\n    ') : ''));

// 9. Speed: a 5 MB YAML file
let big = 'items:\n';
let n = 0;
while (big.length < 5 * 1024 * 1024) { big += `  - id: ${n}\n    name: "User ${n}"\n    email: u${n}@example.com\n    tags: [a, b]\n    active: ${n % 2 === 0}\n`; n++; }
t0 = Date.now();
const bigRes = conv(big);
const ms = Date.now() - t0;
ok(bigRes.ok && JSON.parse(bigRes.json).items.length === n && ms < 15000, `5 MB YAML (${n} items) converts in ${ms} ms`);

// 10. Page interface (jsdom)
const page = new JSDOM('<!doctype html><body><div class="aptdot-yaml2json"></div><div class="aptdot-yaml2json"></div></body>', { runScripts: 'outside-only', pretendToBeVisual: true });
page.window.eval(vendorSrc);
page.window.eval(engineSrc);
if (page.window.document.readyState === 'loading') await new Promise(r => page.window.document.addEventListener('DOMContentLoaded', r));
const roots = page.window.document.querySelectorAll('.aptdot-yaml2json');
ok(roots.length === 2 && [...roots].every(r => r.getAttribute('data-ready') === '1' && r.querySelector('textarea.y2j-input')), 'Two tools on one page both start');
const root = roots[0];
[...root.querySelectorAll('button')].find(b => /Load sample/.test(b.textContent)).click();
const code = root.querySelector('.y2j-code');
const sampleOut = JSON.parse(code.textContent);
ok(sampleOut.services.billing.region === 'eu-west-1' && sampleOut.services.billing.retries === 5 && sampleOut.services.billing.country === 'NO' &&
  sampleOut.services.billing.postcode === '02115' && /"timeout": 2.50/.test(code.textContent) && /12345678901234567890/.test(code.textContent), 'Sample: merge, Norway, leading zero, exact numbers');
ok(/1 document · [\d,]+ values · YAML 1\.2/.test(root.querySelector('.y2j-stats').textContent), 'Stats line');
const ta = root.querySelector('textarea.y2j-input');
ta.value = 'a: "<img src=x onerror=alert(1)>"\n';
[...root.querySelectorAll('button')].find(b => /Convert to JSON/.test(b.textContent)).click();
ok(!root.querySelector('.y2j-output img') && /onerror/.test(root.querySelector('.y2j-code').textContent), 'Hostile input shown as text only');
ta.value = 'a: 1\na: 2';
[...root.querySelectorAll('button')].find(b => /Convert to JSON/.test(b.textContent)).click();
ok(/line 2, column 1/.test(root.querySelector('.y2j-error').textContent), 'Error box shows the position');
const labels = [...root.querySelectorAll('select, input[type=checkbox], textarea')].every(c => c.id ? root.querySelector(`label[for="${c.id}"]`) : c.getAttribute('aria-label'));
ok(labels, 'Every control has a label');
ta.value = 'a: 1\n---\nb: 2';
const docsSel = [...root.querySelectorAll('select')].find(s => s.querySelector('option[value=jsonl]'));
docsSel.value = 'jsonl';
docsSel.dispatchEvent(new page.window.Event('change'));
ok(root.querySelector('.y2j-code').textContent === '{"a":1}\n{"b":2}' && /Download \.jsonl/.test(root.textContent), 'JSON Lines option and .jsonl download');
[...root.querySelectorAll('button')].find(b => /Clear/.test(b.textContent)).click();
ok(ta.value === '' && !root.querySelector('.y2j-code'), 'Clear empties input and output');

{
  const many = Array.from({ length: 30 }, (_, i) => `d${i}: 0${i + 10}`).join('\n');
  const r30 = conv(many);
  ok(r30.warnings.length === 1, 'Repeated notes are grouped into one');
}
console.log(`${pass} passed, ${fail} failed`);
console.log(`  (round trips: ${rtOk}/${rtN}, ${rtSkipped} skipped; site round trips: ${siteOk}/1000)`);
if (fail) { console.log(failures.map(f => '  - ' + f).join('\n')); process.exit(1); }
