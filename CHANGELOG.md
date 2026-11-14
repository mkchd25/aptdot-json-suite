# Changelog

All notable changes to this project are listed here. Versions follow [Semantic Versioning](https://semver.org/).

## [2.1.0] - 2026-11-13

### Added
- CSV to JSON converter (`src/csv-to-json.js`, `src/csv-to-json.css`), live at https://www.aptdot.com/tools/csv-to-json/.
  - RFC 4180 parsing: quoted fields, doubled quotes, line breaks inside cells, CRLF, LF and CR line endings.
  - Detects comma, semicolon, tab and pipe; honours an Excel `sep=` line and removes the UTF-8 byte-order mark.
  - Typed output that never changes a value: leading zeros, `+5`, `.5`, integers above 2^53 and long decimals stay text, and a column is typed only if every value fits.
  - Nested objects from dotted headers, JSON inside cells, JSON Lines output, and warnings with line numbers for ragged rows and duplicate or empty headers.
- Automated tests and a GitHub Actions workflow.

### Fixed
- JSON to CSV dropped a column named `__proto__`.
- JSON to TypeScript and JSON to Python dropped keys named after built-in object properties, such as `constructor` or `toString`, and JSON to Python renamed `constructor` to `constructor_2`. Internal key maps now have no prototype.

## [2.0.0] - 2026-11-10

This is the engine that has been running on aptdot.com. Upgrading is recommended for anyone who copied v1.

### Security
- Text derived from user input (parse errors, validator messages, history labels) is no longer inserted into the page as HTML. v1 could run script from a crafted share link or input, because browser JSON error messages quote the input.
- Loading from a URL now asks before using the third-party proxy `allorigins.win`, and says that the URL will be sent to it. v1 used the proxy without asking.

### Fixed
- Share links use base64url and decode `+`, `%` and non-ASCII characters correctly. Old v1 links still open.
- Blocked or full browser storage no longer stops the tool; history is optional.
- Input is parsed exactly as written first. Trailing commas are repaired only if parsing fails, never inside strings, and every repair is reported.
- Converter output is checked to parse: YAML (js-yaml and PyYAML), TypeScript (`tsc`), Pydantic v2, RFC 4180 CSV and well-formed XML.
- No inline styles and no `alert()` pop-ups for results.

### Changed
- Rewritten in plain ES5 so older minifiers and server-side editors can process it.

## [1.0.0] - 2026-09-18

- First public release: formatter, minifier, JSON-LD validator and converters to YAML, CSV, TypeScript, Python and Markdown.

[2.1.0]: https://github.com/mkchd25/aptdot-json-suite/releases/tag/v2.1.0
[2.0.0]: https://github.com/mkchd25/aptdot-json-suite/releases/tag/v2.0.0
