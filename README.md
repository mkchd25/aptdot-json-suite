# Aptdot JSON Suite

Free, browser-based JSON tools: format, minify, validate, convert CSV to JSON, and convert JSON to YAML, CSV, TypeScript, Python (Pydantic v2) and Markdown. Your data is processed in your own browser and is not uploaded.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Tests](https://github.com/mkchd25/aptdot-json-suite/actions/workflows/test.yml/badge.svg)](https://github.com/mkchd25/aptdot-json-suite/actions/workflows/test.yml)
[![Live tools](https://img.shields.io/badge/live-aptdot.com-58a6ff.svg)](https://www.aptdot.com/)

This repository holds the JavaScript engine that runs the JSON tools on [aptdot.com](https://www.aptdot.com/), so anyone can check what happens to their data.

## Live tools

| Tool | What it does |
| :--- | :--- |
| [JSON Formatter & Minifier](https://www.aptdot.com/tools/json-formatter-minifier/) | Pretty-print or minify JSON, with line-and-column error messages |
| [JSON-LD Schema Validator](https://www.aptdot.com/tools/json-ld-validator/) | Checks Schema.org JSON-LD syntax and common structured-data mistakes |
| [JSON to YAML Converter](https://www.aptdot.com/tools/json-to-yaml/) | YAML 1.2 output for Docker Compose, Kubernetes and CI files |
| [JSON to CSV Converter](https://www.aptdot.com/tools/json-to-csv/) | RFC 4180 CSV with correct quoting of commas, quotes and line breaks |
| [CSV to JSON Converter](https://www.aptdot.com/tools/csv-to-json/) | Typed, nested JSON or JSON Lines from CSV, with delimiter detection and safe handling of leading zeros and long IDs |
| [JSON to TypeScript Converter](https://www.aptdot.com/tools/json-to-typescript/) | TypeScript interfaces that compile with `tsc` |
| [JSON to Python Converter](https://www.aptdot.com/tools/json-to-python/) | Pydantic v2 models, with aliases for keys that are Python keywords |
| [JSON to Markdown Converter](https://www.aptdot.com/tools/json-to-markdown/) | GitHub-flavoured Markdown tables |
| [Mock JSON Data Generator](https://www.aptdot.com/tools/mock-json-generator/) | Sample payloads for users, products and locations |

## More from Aptdot

- [JWT Decoder & Verifier](https://www.aptdot.com/tools/jwt-decoder/): decode, verify and security-check JSON Web Tokens in the browser ([source](https://github.com/mkchd25/aptdot-jwt-decoder))
- [Developer datasets](https://www.aptdot.com/datasets/): 10 free JSON test datasets, from security headers to ISO currencies ([source](https://github.com/mkchd25/aptdot-datasets))

## Privacy: what leaves your browser

Formatting, validation and conversion happen entirely in your browser. The tools make no network request with your data, with these exceptions, which only happen when you use them:

- **Load from URL** requests that URL from your browser. If the site blocks it, the tool asks before retrying through the public proxy `allorigins.win`, which would then see the URL.
- **Share link** puts your JSON inside the link. Anyone with the link can read it, and like any web address it reaches the web server when opened. Do not share sensitive data this way.
- **Recent history** keeps your last 5 inputs in your browser's local storage on your own device, when storage is available.

Even for a page that uploads nothing, other scripts in your browser, such as extensions, can read what you paste. Use test data or redacted copies rather than live secrets.

## About the code

- `src/json-formatter.js`: the complete engine. Plain ES5, no build step and no required dependencies. If `js-yaml` is present on the page it is used for YAML output; otherwise a built-in YAML 1.2 writer is used.
- Text from your input is never inserted into the page as HTML, which prevents script injection through crafted JSON or share links.
- Output is checked to parse in its target format: YAML with js-yaml and PyYAML, TypeScript with `tsc`, Python with Pydantic v2, CSV against RFC 4180.

- `src/csv-to-json.js` and `src/csv-to-json.css`: the CSV to JSON converter. It is separate from the main engine, makes no network requests and stores nothing.

The main engine expects the page markup used on aptdot.com, so the simplest way to try it is on the [live site](https://www.aptdot.com/tools/json-formatter-minifier/).

## CSV to JSON in your own code

`src/csv-to-json.js` also works as a small library. Load it on a page and call `AptdotCsvToJson.convert`:

```html
<script src="csv-to-json.js"></script>
<script>
  var result = AptdotCsvToJson.convert('id,name,zip\n1,Priya,02115');
  // result.data -> [{ "id": 1, "name": "Priya", "zip": "02115" }]
  // result.json is the formatted text; result.warnings and result.errors explain problems
</script>
```

Options (all optional; these are the defaults): `delimiter: 'auto'`, `header: true`, `types: true`, `consistent: true` (a column is typed only if every value fits), `jsonCells: true`, `nested: true` (dotted headers become objects), `trim: false`, `unguard: false` (remove the `'` formula guard), `empty: 'string'` (or `'null'`, `'omit'`), `output: 'objects'` (or `'arrays'`, `'ndjson'`), `indent: 2` (or `4`, `'\t'`, `0`).

## Tests

```
npm ci
npm test
```

The tests check the CSV parser against Python's `csv` module on 600 generated files, check that CSV written by the JSON to CSV converter converts back to the same data, and test the page interface in jsdom. They run on every push.

## Changelog, security and issues

- [CHANGELOG.md](CHANGELOG.md) lists every release.
- Found a security problem? Please follow [SECURITY.md](SECURITY.md) instead of opening a public issue.
- Bugs and ideas: [open an issue](https://github.com/mkchd25/aptdot-json-suite/issues/new/choose).

## License

[MIT](LICENSE) © 2026 Aptdot
