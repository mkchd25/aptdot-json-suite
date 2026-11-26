// Tests for JSON Compare.
// Usage: node tests/test-json-compare.mjs [json-compare.js] [node_modules] [JSONTestSuite/test_parsing dir (optional)]
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const [, , enginePath = 'src/json-compare.js', nm = 'node_modules', suiteDir = ''] = process.argv;
const require = createRequire(path.join(path.resolve(nm), 'x.js'));
const { JSDOM } = require('jsdom');
const acorn = require('acorn');
const jsonpatch = require('fast-json-patch');

let pass = 0, fail = 0;
const failures = [];
const ok = (cond, name) => { if (cond) pass++; else { fail++; failures.push(name); } };
function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  if (typeof a !== 'object') return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every(k => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
}

const src = fs.readFileSync(enginePath, 'utf8');
let es5 = true;
try { acorn.parse(src, { ecmaVersion: 5 }); } catch (e) { es5 = false; }
ok(es5, 'Engine parses as ES5');
ok(!/fetch\(|XMLHttpRequest|sendBeacon|localStorage|sessionStorage|document\.cookie|innerHTML|eval\(|new Function/.test(src), 'Engine: no network, storage, innerHTML or eval');

const dom = new JSDOM('<body></body>', { runScripts: 'outside-only' });
dom.window.eval(src);
const C = dom.window.AptdotJsonCompare;
const cmp = (a, b, o) => C.compare(a, b, o);
const kinds = r => r.changes.map(c => c.kind + ' ' + C.readablePath(c.rpath || c.lpath)).join('; ');
const applyPatch = (a, r) => jsonpatch.applyPatch(jsonpatch.deepClone(JSON.parse(a)), JSON.parse(C.patchToJson(r.patch, false)), true).newDocument;

// 1. Reader: exact numbers, errors with positions, JSONC, duplicates
ok(C.canonNumber('1') === C.canonNumber('1.0') && C.canonNumber('1') === C.canonNumber('10e-1') && C.canonNumber('-0') === C.canonNumber('0') &&
  C.canonNumber('100') === C.canonNumber('1e2') && C.canonNumber('12345678901234567890') !== C.canonNumber('12345678901234567891'), 'Number identity is exact');
const e1 = cmp('{"a":1,\n"b":}', '{}');
ok(!e1.ok && e1.errors[0].side === 'left' && e1.errors[0].line === 2 && e1.errors[0].col === 5, 'Error position (line 2, column 5)');
ok(cmp('{"a":1\n "b":2}', '{}').errors[0].message === 'A comma is missing before this key' && cmp('[1 2]', '[]').errors[0].message === 'A comma is missing before this item' && /found "x"/.test(cmp('[1 x]', '[]').errors[0].message), 'Missing comma explained');
ok(/single quote/.test(cmp("{'a':1}", '{}').errors[0].message), 'Single quotes explained');
ok(/cannot start with 0/.test(cmp('{"a":012}', '{}').errors[0].message), 'Leading zero explained');
ok(/line break is not allowed/.test(cmp('{"a":"x\ny"}', '{}').errors[0].message), 'Raw line break in a string explained');
ok(cmp('', '{}').errors[0].message === 'This side is empty', 'Empty side explained');
const jc = cmp('{\n  // a comment\n  "a": [1, 2,],\n  /* block */ "b": 2,\n}', '{"a":[1,2],"b":2}');
ok(jc.ok && jc.stats.total === 0 && jc.notes.some(n => /2 comments and 2 trailing commas ignored/.test(n)), 'JSONC comments and trailing commas accepted with a note');
const dup = cmp('{"a":1,"a":2}', '{"a":2}');
ok(dup.ok && dup.stats.total === 0 && dup.notes.some(n => /duplicate key "a" \(line 1\)/.test(n)), 'Duplicate keys: last value used, with a note');
ok(C.parse('{"a":1} // x', { jsonc: false }).ok === false, 'Strict mode rejects comments');
ok(cmp('﻿{"a":1}', '{"a":1}').stats.total === 0, 'Byte-order mark ignored');
ok(!cmp('['.repeat(1200) + ']'.repeat(1200), '[]').ok, 'Very deep nesting stopped with a message');

// 2. Differences
ok(cmp('{"id":12345678901234567890}', '{"id":12345678901234567891}').stats.total === 1, 'Large integers that differ in the last digit are different');
const nf = cmp('{"a":1,"b":1e2,"c":2.50}', '{"a":1.0,"b":100,"c":2.5}');
ok(nf.stats.total === 0 && nf.notes.some(n => /3 numbers are written differently/.test(n)), '1 vs 1.0: equal by value with a note');
ok(cmp('{"a":1}', '{"a":1.0}', { numbersByValue: false }).stats.total === 1, '1 vs 1.0: different when the option is off');
ok(cmp('{"a":1}', '{"a":1.0}').patch.length === 0 && C.patchToJson(cmp('{"a":1}', '{"a":1.0}', { numbersByValue: false }).patch, false) === '[{"op": "replace", "path": "/a", "value": 1.0}]', 'Patch follows the "1 and 1.0" option');
const whole = cmp('{"t":"x","l":[1,2]}', '{"t":"y","l":[2,1]}', { ignoreKeys: 't', arrays: 'unordered' });
ok(whole.stats.total === 0 && whole.patch.length > 0 && whole.patchCoversAll && deepEqual(applyPatch('{"t":"x","l":[1,2]}', whole), { t: 'y', l: [2, 1] }), 'Patch covers the whole document even with ignored keys and ignore order');
ok(cmp('{"b":2,"a":1}', '{"a":1,"b":2}').stats.total === 0, 'Key order does not matter');
ok(kinds(cmp('[1,2,3,4,5]', '[1,2,9,3,4,5]')) === 'added [2]', 'Smart lists: one inserted item');
ok(kinds(cmp('[1,2,3,4,5]', '[1,3,4,5]')) === 'removed [1]', 'Smart lists: one removed item');
ok(cmp('[1,2,3,4,5]', '[1,2,9,3,4,5]', { arrays: 'position' }).stats.total === 4, 'By position: everything after the insert counts');
ok(cmp('[3,1,2,2]', '[2,1,2,3]', { arrays: 'unordered' }).stats.total === 0 && cmp('[1,1,2]', '[1,2,2]', { arrays: 'unordered' }).stats.total === 1, 'Ignore order (repeated items counted)');
ok(cmp('{"a":[[1,2],[3,[4,5]]]}', '{"a":[[[5,4],3],[2,1]]}', { arrays: 'unordered' }).stats.total === 0, 'Ignore order also applies to lists inside lists');
const bk = cmp('[{"id":1,"v":"a"},{"id":2,"v":"b"}]', '[{"id":2,"v":"B"},{"id":1,"v":"a"},{"id":3,"v":"c"}]', { arrays: 'key', arrayKey: 'id' });
ok(bk.stats.changed === 1 && bk.stats.added === 1 && bk.stats.removed === 0 && C.readablePath(bk.changes[0].rpath) === '[0].v', 'Match by key: moved items are not changes');
ok(cmp('[1,2]', '[2,1]', { arrays: 'key', arrayKey: 'id' }).notes.some(n => /could not be matched by "id"/.test(n)), 'Match by key falls back with a note');
const ig = cmp('{"a":1,"meta":{"updatedAt":"x","etag":"1"}}', '{"a":1,"meta":{"updatedAt":"y","etag":"2"}}', { ignoreKeys: 'updatedAt, etag' });
ok(ig.stats.total === 0 && ig.notes.some(n => /ignored keys/.test(n)), 'Ignore keys anywhere in the document');
const nullRes = cmp('{"a":1,"b":null,"c":{"d":null}}', '{"a":1,"c":{}}', { nullEqualsMissing: true });
ok(nullRes.stats.total === 0 && nullRes.notes.some(n => /2 keys set to null on one side and missing/.test(n)) && nullRes.patch.length === 2, '"Missing key = null": not counted, noted, still in the patch');
ok(cmp('{"a":null}', '{}').stats.removed === 1 && cmp('{"a":null}', '{"a":0}', { nullEqualsMissing: true }).stats.changed === 1, '"Missing key = null" is off by default and never hides a real value');
ok(cmp('[{"id":1,"x":null}]', '[{"id":1}]', { nullEqualsMissing: true, arrays: 'unordered' }).stats.total === 0, '"Missing key = null" also applies when matching list items');
ok(kinds(cmp('[{"id":1,"x":null},{"id":2}]', '[{"id":0},{"id":1},{"id":2}]', { nullEqualsMissing: true })) === 'added [0]', '"Missing key = null" lets smart lists see equal items');
ok(cmp('{"a":5,"b":null}', '{"c":"x"}', { nullEqualsMissing: true }).stats.removed === 1 && cmp('{"c":"x"}', '{"a":5,"b":null}', { nullEqualsMissing: true }).stats.added === 1, '"Missing key = null" still reports keys with real values');
const fb = cmp('{"tags":["a"],"users":[{"id":1}],"more":[1,2]}', '{"tags":["b"],"users":[{"id":1}],"more":[2,1]}', { arrays: 'key', arrayKey: 'id' });
ok(fb.notes.some(n => /2 lists could not be matched by "id": tags, more /.test(n)), 'Fallback note names the lists');
const md = C.changesToMarkdown(cmp('{"a|b":"x`y","n":1}', '{"a|b":"z","m":[1]}').changes);
ok(md.split('\n')[0] === '| Path | Change | Left | Right |' && md.includes('| `["a\\|b"]` | Changed | `` "x`y" `` | `"z"` |') && md.includes('| `m` | Added |  | `[1 item]` |'), 'Copy as Markdown: table with escaped pipes and backticks');
const ty = cmp('{"a":"1","b":null,"c":[1]}', '{"a":1,"b":{},"c":{"0":1}}');
ok(ty.stats.changed === 3 && ty.changes.every(c => c.kind === 'type'), 'Type changes');
ok(cmp('{"a/b":1,"c~d":2}', '{"a/b":2,"c~d":2}').patch[0].path === '/a~1b', 'JSON Pointer escaping (~1, ~0)');
ok(C.readablePath(['users', 0, 'first name', 'x']) === 'users[0]["first name"].x', 'Readable paths');
const proto = cmp('{"__proto__":{"x":1},"constructor":1}', '{"__proto__":{"x":2},"constructor":1}');
ok(proto.stats.total === 1 && dom.window.Object.prototype.x === undefined && ({}).x === undefined, 'No prototype pollution; __proto__ compared as data');
const s = cmp(C.sample.left, C.sample.right);
ok(s.stats.total === 7 && s.stats.added === 3 && s.stats.changed === 4, 'Sample: 7 differences');

// 3. JSON Patch from random edits, applied by fast-json-patch (independent)
let seed = 11;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const KEYS = ['a', 'b', 'id', 'name', 'x y', 'a/b', 'c~d', '__proto__', 'constructor', 'toString', '0', '', 'é'];
function rv(depth) {
  const r = rnd();
  if (depth > 3 || r < 0.4) {
    const k = Math.floor(rnd() * 6);
    if (k === 0) return 'v' + Math.floor(rnd() * 5);
    if (k === 1) return Math.floor(rnd() * 5);
    if (k === 2) return Math.round(rnd() * 100) / 10;
    if (k === 3) return rnd() < 0.5;
    if (k === 4) return null;
    return ['', 'Zoë', 'line\nbreak', '"q"'][Math.floor(rnd() * 4)];
  }
  if (r < 0.7) { const a = []; for (let i = 0, n = Math.floor(rnd() * 6); i < n; i++) a.push(rv(depth + 1)); return a; }
  const o = {};
  for (let i = 0, n = Math.floor(rnd() * 5); i < n; i++) Object.defineProperty(o, KEYS[Math.floor(rnd() * KEYS.length)], { value: rv(depth + 1), enumerable: true, configurable: true, writable: true });
  return o;
}
function mutate(v, depth) {
  if (rnd() < 0.15) return rv(depth);
  if (Array.isArray(v)) {
    const a = v.map(x => (rnd() < 0.3 ? mutate(x, depth + 1) : x));
    if (rnd() < 0.3) a.splice(Math.floor(rnd() * (a.length + 1)), 0, rv(depth + 1));
    if (rnd() < 0.3 && a.length) a.splice(Math.floor(rnd() * a.length), 1);
    if (rnd() < 0.15) a.reverse();
    return a;
  }
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v)) if (rnd() > 0.15) Object.defineProperty(o, k, { value: rnd() < 0.3 ? mutate(v[k], depth + 1) : v[k], enumerable: true, configurable: true, writable: true });
    if (rnd() < 0.3) Object.defineProperty(o, KEYS[Math.floor(rnd() * KEYS.length)], { value: rv(depth + 1), enumerable: true, configurable: true, writable: true });
    return o;
  }
  return rnd() < 0.5 ? rv(depth) : v;
}
let patchOk = 0, eqOk = 0, protoDocs = 0, N = 3000;
const bad = [];
for (let i = 0; i < N; i++) {
  const a = rv(0), b = rnd() < 0.15 ? JSON.parse(JSON.stringify(a)) : mutate(a, 0);
  const ja = JSON.stringify(a), jb = JSON.stringify(b);
  const r = cmp(ja, jb);
  const same = deepEqual(JSON.parse(ja), JSON.parse(jb));
  if ((r.stats.total === 0) === same && (r.patch.length === 0) === same) eqOk++; else if (bad.length < 3) bad.push('equality: ' + ja.slice(0, 80) + ' vs ' + jb.slice(0, 80));
  if (/__proto__/.test(ja + jb)) { protoDocs++; patchOk++; continue; } // fast-json-patch refuses __proto__ on purpose; checked separately below
  let out;
  try { out = applyPatch(ja, r); } catch (e) { out = { error: e.message }; }
  if (deepEqual(out, JSON.parse(jb))) patchOk++; else if (bad.length < 3) bad.push('patch: ' + ja.slice(0, 80) + ' -> ' + jb.slice(0, 80) + ' :: ' + C.patchToJson(r.patch, false).slice(0, 150));
}
ok(eqOk === N, `"No differences" exactly when the documents are equal: ${eqOk}/${N}` + (bad.length ? '\n    ' + bad.join('\n    ') : ''));
ok(patchOk === N, `JSON Patch applied by fast-json-patch gives the right side: ${patchOk}/${N}`);

ok(protoDocs > 0 && protoDocs < N / 3, `Documents with a "__proto__" key were generated (${protoDocs})`);
ok(C.patchToJson(cmp('{"__proto__":{"a":1}}', '{"__proto__":{"a":2},"x":[1]}').patch, false) === '[{"op": "replace", "path": "/__proto__/a", "value": 2},{"op": "add", "path": "/x", "value": [1]}]', 'Patch for a "__proto__" key is exact');

// Ignore order and match-by-key agree with shuffles
let shufOk = 0;
for (let i = 0; i < 500; i++) {
  const items = Array.from({ length: 1 + Math.floor(rnd() * 8) }, (_, k) => ({ id: k, v: rv(2) }));
  const shuffled = items.slice().sort(() => rnd() - 0.5);
  const a = JSON.stringify(items), b = JSON.stringify(shuffled);
  if (cmp(a, b, { arrays: 'unordered' }).stats.total === 0 && cmp(a, b, { arrays: 'key', arrayKey: 'id' }).stats.total === 0) shufOk++;
}
ok(shufOk === 500, `Shuffled lists are equal under "Ignore order" and "Match by key": ${shufOk}/500`);

// 4. JSONTestSuite (strict reader): y_ accepted with the same value as JSON.parse, n_ rejected
if (suiteDir && fs.existsSync(suiteDir)) {
  let y = 0, yOk = 0, n = 0, nOk = 0;
  const wrong = [];
  for (const f of fs.readdirSync(suiteDir)) {
    const text = fs.readFileSync(path.join(suiteDir, f), 'utf8');
    if (f.startsWith('y_')) {
      y++;
      const r = C.parse(text, { jsonc: false });
      let same = false;
      try { same = r.ok && deepEqual(JSON.parse(C.toJson(r.value, '', 0)), JSON.parse(text)); } catch (e) { same = false; }
      if (same) yOk++; else wrong.push(f);
    } else if (f.startsWith('n_')) {
      n++;
      if (!C.parse(text, { jsonc: false }).ok) nOk++; else wrong.push(f);
    }
  }
  ok(yOk === y && nOk === n, `JSONTestSuite: ${yOk}/${y} valid files accepted, ${nOk}/${n} invalid files rejected` + (wrong.length ? ' (' + wrong.slice(0, 6).join(', ') + ')' : ''));
}

// 5. Speed: two 5 MB documents with a few changes
const big = { items: Array.from({ length: 50000 }, (_, k) => ({ id: k, name: 'User ' + k, email: 'u' + k + '@example.com', tags: ['a', 'b'], active: k % 2 === 0 })) };
const big2 = JSON.parse(JSON.stringify(big));
big2.items[100].name = 'Changed';
big2.items.splice(25000, 0, { id: -1, name: 'New' });
big2.items.pop();
const A = JSON.stringify(big, null, 1), B = JSON.stringify(big2, null, 1);
let t0 = Date.now();
const br = cmp(A, B);
const ms = Date.now() - t0;
ok(br.ok && br.stats.total === 3 && ms < 20000, `Two ${(A.length / 1048576).toFixed(1)} MB documents compared in ${ms} ms with the 3 real differences found`);

// 6. Page interface (jsdom)
const page = new JSDOM('<!doctype html><body><div class="aptdot-json-compare"></div><div class="aptdot-json-compare"></div></body>', { runScripts: 'outside-only', pretendToBeVisual: true });
page.window.eval(src);
if (page.window.document.readyState === 'loading') await new Promise(r => page.window.document.addEventListener('DOMContentLoaded', r));
const roots = page.window.document.querySelectorAll('.aptdot-json-compare');
ok(roots.length === 2 && [...roots].every(r => r.getAttribute('data-ready') === '1' && r.querySelectorAll('textarea.jc-input').length === 2), 'Two tools on one page both start');
const root = roots[0];
const btn = t => [...root.querySelectorAll('button')].find(b => b.textContent.includes(t));
btn('Load sample').click();
ok(/7 differences: 4 changed · 3 added · 0 removed/.test(root.querySelector('.aptdot-panel-title').textContent), 'Sample summary');
ok(root.querySelectorAll('.jc-table tbody tr').length === 7 && root.querySelectorAll('.jc-sides .jc-chg').length > 0 && root.querySelectorAll('.jc-sides .jc-add').length > 0, 'Change list and side-by-side highlights');
const patchShown = JSON.parse(root.querySelector('.jc-patch').textContent);
ok(Array.isArray(patchShown) && patchShown.length === 7, 'JSON Patch shown and valid');
const [ta1, ta2] = root.querySelectorAll('textarea.jc-input');
ta1.value = '{"x":"<img src=x onerror=alert(1)>"}';
ta2.value = '{"x":"<script>alert(2)</script>"}';
btn('Compare').click();
ok(!root.querySelector('.jc-output img, .jc-output script') && /onerror/.test(root.querySelector('.jc-table').textContent), 'Hostile values shown as text only');
ta1.value = '{"a":1,}x';
btn('Compare').click();
ok(/Left side, line 1, column 9/.test(root.querySelector('.jc-error').textContent), 'Error box names the side and position');
btn('Swap sides').click();
ok(ta2.value === '{"a":1,}x' && /Right side/.test(root.querySelector('.jc-error').textContent), 'Swap sides');
const labels = [...root.querySelectorAll('select, input[type=checkbox], input[type=text], textarea')].every(c => c.id ? root.querySelector(`label[for="${c.id}"]`) : c.getAttribute('aria-label'));
ok(labels, 'Every control has a label');
ta1.value = '{"a":1,"updatedAt":"x"}';
ta2.value = '{"a":1,"updatedAt":"y"}';
root.querySelectorAll('input[type=text]')[1].value = 'updatedAt';
btn('Compare').click();
ok(/No differences/.test(root.querySelector('.aptdot-panel-title').textContent) && !root.querySelector('.jc-table') && JSON.parse(root.querySelector('.jc-patch').textContent).length === 1 && /differ only in what your options ignore/.test(root.textContent), 'Patch still shown when the only differences are ignored');
root.querySelectorAll('input[type=text]')[1].value = '';
btn('Clear').click();
ok(ta1.value === '' && ta2.value === '' && !root.querySelector('.jc-table'), 'Clear');

console.log(`  big: ${ms} ms, ${br.stats.total} differences, notes: ${br.notes.length}`);
console.log(`${pass} passed, ${fail} failed`);
if (fail) { console.log(failures.map(f => '  - ' + f).join('\n')); process.exit(1); }
