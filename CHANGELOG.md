# Changelog

All notable changes to this project are listed here. Versions follow [Semantic Versioning](https://semver.org/).

## [2.3.0] - 2026-11-25

### Added
- JSON Compare (`src/json-compare.js`, `src/json-compare.css`), live at https://www.aptdot.com/tools/json-compare/.
  - Lists every added, removed and changed value with its path, and highlights the lines side by side.
  - Reads JSON with its own parser, so large numbers are compared digit by digit (`12345678901234567890` and `12345678901234567891` are different); `1`, `1.0` and `1e0` count as equal by default, with a note.
  - Key order never counts as a difference. Lists can be compared smartly (Myers difference algorithm), by position, ignoring order, or by matching objects on a key such as `id`.
  - Keys such as `updatedAt` can be ignored anywhere in the document.
  - Duplicate keys, comments and trailing commas are accepted and reported; syntax errors show the side, line and column.
  - Exports the changes as JSON Patch (RFC 6902) with exact numbers; the patch stays available when the only differences are ones your options ignore.
  - "Missing key = null" option, for comparing programs that leave out empty fields with ones that write them as `null`.
  - Click a path in the change list to jump to it in the side-by-side view; "Copy as Markdown" copies the list for pull requests and tickets; uploaded file names are shown above each side.
- Tests: `tests/test-json-compare.mjs` (3,000 random pairs whose patch is applied by fast-json-patch, page interface in jsdom).

## [2.2.0] - 2026-11-20

### Added
- YAML to JSON converter (`src/yaml-to-json.js`, `src/yaml-to-json.css`), live at https://www.aptdot.com/tools/yaml-to-json/.
  - YAML 1.2 rules: `NO`, `yes`, `on` and dates stay text. Files that declare `%YAML 1.1` are read with YAML 1.1 rules, with a note.
  - Numbers keep the digits written in the YAML (`2.50` stays `2.50`, very large integers keep every digit); numbers written with a leading zero (`02115`, `0644`) stay text by default.
  - Anchors, aliases and merge keys (`<<`); key order kept exactly; sets and ordered maps keep their contents.
  - CloudFormation tags (`!Ref`, `!Sub`, `!GetAtt` ...) become their JSON forms; other custom tags are kept as keys.
  - Multiple documents as a JSON array, JSON Lines or first only; duplicate keys and syntax errors reported with line and column.
  - Integers are read exactly at any size and in any notation (hex, octal, `!!int "..."`) and written as plain decimal digits.
  - Alias bombs and self-referencing aliases (also when used as keys) are stopped with a clear message.
- Bundled YAML parser: `src/vendor/yaml.min.js` (yaml 2.9.1 by Eemeli Aro, ISC licence).

## [2.1.2] - 2026-11-18

### Security
- Ad and analytics scripts could read a share link's data from the address bar before the tool removed it: AdSense sends the full page address, including the part after `#`, with its ad request. A small script now runs at the very top of the page (`src/share-link-guard.js`, printed inline by the WordPress plugin), removes the data from the address bar before any other script loads, and hands it to the engine through `window.__aptdotShareStash`.

### Fixed
- JSON to CSV and JSON to Markdown printed `function Object() { [native code] }` (or similar) in a row that lacked a column named after a built-in, such as `constructor` or `toString`. Missing columns are now empty.

### Changed
- The engine reads the handed-over data when present, and still reads the address bar itself when the guard is not used.

## [2.1.1] - 2026-11-18

### Security
- Share links now keep the JSON after `#` (`#data=`) instead of in the query string (`?data=`). Browsers never send the part after `#` to the server, so shared JSON no longer reaches server logs, CDN logs or analytics as part of the page request.
- When a share link is opened, the JSON is removed from the address bar after it loads, so it is not kept in browser history.

### Changed
- Older `?data=` links still open, and are cleaned from the address bar in the same way.
- A share link pasted into the address bar of an open tool page now loads.

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

[2.2.0]: https://github.com/mkchd25/aptdot-json-suite/releases/tag/v2.2.0
[2.1.2]: https://github.com/mkchd25/aptdot-json-suite/releases/tag/v2.1.2
[2.1.1]: https://github.com/mkchd25/aptdot-json-suite/releases/tag/v2.1.1
[2.1.0]: https://github.com/mkchd25/aptdot-json-suite/releases/tag/v2.1.0
[2.0.0]: https://github.com/mkchd25/aptdot-json-suite/releases/tag/v2.0.0
