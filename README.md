# Aptdot JSON & Data Engineering Suite

A collection of lightweight, 100% client-side developer utilities designed for privacy-conscious engineers handling sensitive configurations, internal API payloads, and database exports.

All parsing, formatting, and conversion executes entirely within local browser memory using native Web APIs—zero server uploads, zero remote logging, and zero telemetry.

---

## 🛠️ Live Tools & Web Access

| Utility Name | Description | Web Application |
| :--- | :--- | :--- |
| **JSON Formatter & Minifier** | RFC 8259 pretty-printing (2/4 spaces) and single-line compression | [Launch Tool](https://www.aptdot.com/tools/json-formatter/) |
| **JSON-LD Schema Validator** | Schema.org syntax repair, missing `@context` injection | [Launch Tool](https://www.aptdot.com/tools/json-ld-validator/) |
| **JSON to YAML Converter** | Valid YAML 1.2 manifests for Docker Compose and Kubernetes | [Launch Tool](https://www.aptdot.com/tools/json-to-yaml/) |
| **JSON to CSV Converter** | RFC 4180 tabular serialization with array flattening | [Launch Tool](https://www.aptdot.com/tools/json-to-csv/) |
| **JSON to TypeScript Converter** | Strongly typed TypeScript interface generation | [Launch Tool](https://www.aptdot.com/tools/json-to-typescript/) |
| **JSON to Python Converter** | Pydantic v2 classes and typed dictionary structures | [Launch Tool](https://www.aptdot.com/tools/json-to-python/) |
| **JSON to Markdown Converter** | Clean GitHub/GitLab-flavored documentation tables | [Launch Tool](https://www.aptdot.com/tools/json-to-markdown/) |
| **Mock JSON Data Generator** | Synthetic mock payloads for users, products, and geo coordinates | [Launch Tool](https://www.aptdot.com/tools/mock-json-generator/) |

---

## 🔒 Security & Execution Model

- **No Remote Processing:** Input payloads are parsed via browser `JSON.parse()` loops. Network tabs reflect zero outbound payload requests.
- **Client Sandbox:** Safe for testing production credentials, JWTs, and internal customer JSON records.

## 📄 License

Open source under the [MIT License](LICENSE).
