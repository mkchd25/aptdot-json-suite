/**
 * Aptdot JSON & Schema Suite - Complete Unified Engine
 * Fully patched for:
 * 1. RFC 4180 CSV Escaping & Preserved JSON-in-Cell
 * 2. GFM Markdown Table Line-Break (<br>) & Pipe Delimiter Integrity
 * 3. Pydantic v2 Python Keyword Sanitization & Field Aliasing
 * 4. TypeScript Type-Safe Array & Primitive Inferences
 */
(function () {
  function initAptdotJsonSuite() {
    const jsonInput = document.getElementById('jsonInput');
    const jsonOutput = document.getElementById('jsonOutput');
    const inputGutter = document.getElementById('inputGutter');
    const modeSelect = document.getElementById('modeSelect');
    const mockSelect = document.getElementById('mockSelect');
    const historySelect = document.getElementById('historySelect');
    const fileInput = document.getElementById('jsonFileInput');
    const fetchUrlBtn = document.getElementById('fetchUrlBtn');
    const shareUrlBtn = document.getElementById('shareUrlBtn');

    if (!jsonInput || !jsonOutput) return;

    // URL Parameter Hydration (?data=...)
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.has('data')) {
      try {
        jsonInput.value = decodeURIComponent(atob(urlParams.get('data')));
        updateGutter();
      } catch (e) {
        console.warn('Invalid shared URL data payload.');
      }
    }

    // 1. Line Gutter Synchronization
    function updateGutter() {
      if (!inputGutter) return;
      const lines = (jsonInput.value.match(/\n/g) || []).length + 1;
      let spans = '';
      for (let i = 1; i <= lines; i++) {
        spans += `<span>${i}</span>`;
      }
      inputGutter.innerHTML = spans;
    }
    jsonInput.addEventListener('input', updateGutter);
    jsonInput.addEventListener('scroll', function () {
      if (inputGutter) inputGutter.scrollTop = jsonInput.scrollTop;
    });

    // 2. Syntax Sanitizer
    function sanitizeRawJSON(raw) {
      return raw.replace(/,(\s*[}\]])/g, '$1');
    }

    // 3. Schema.org Semantic Linter (Zero False Positives)
    function inspectSchemaSemantics(obj) {
      const issues = [];
      const warnings = [];
      const fixes = [];

      if (!obj['@context']) {
        issues.push('Missing <code>@context</code> declaration.');
        obj['@context'] = 'https://schema.org';
        fixes.push('Auto-injected <code>"@context": "https://schema.org"</code>');
      } else if (typeof obj['@context'] === 'string') {
        const rawContext = obj['@context'].trim();
        if (rawContext === 'http://schema.org' || rawContext === 'http://schema.org/') {
          warnings.push('Insecure HTTP <code>@context</code> detected.');
          obj['@context'] = 'https://schema.org';
          fixes.push('Upgraded <code>@context</code> to secure <code>https://schema.org</code>');
        } else if (rawContext === 'schema.org' || rawContext === 'schema.org/') {
          warnings.push('Non-canonical <code>@context</code> missing protocol.');
          obj['@context'] = 'https://schema.org';
          fixes.push('Normalized <code>@context</code> to <code>https://schema.org</code>');
        } else if (rawContext !== 'https://schema.org' && rawContext !== 'https://schema.org/') {
          warnings.push(`Custom context: <code>${rawContext}</code>`);
        }
      }

      if (!obj['@type']) {
        issues.push('Missing primary entity declaration (<code>@type</code>).');
      }

      if (obj.offers) {
        const offers = Array.isArray(obj.offers) ? obj.offers : [obj.offers];
        offers.forEach((offer, i) => {
          if (offer.availability && typeof offer.availability === 'string') {
            const rawAvail = offer.availability.trim();
            const canonicalPrefix = 'https://schema.org/';
            if (rawAvail.startsWith('http://schema.org/')) {
              const enumVal = rawAvail.replace('http://schema.org/', '');
              offer.availability = `${canonicalPrefix}${enumVal}`;
              warnings.push(`Offer ${i + 1}: Insecure HTTP availability URI.`);
              fixes.push(`Updated <code>availability</code> to <code>${offer.availability}</code>`);
            } else if (!rawAvail.startsWith(canonicalPrefix)) {
              const cleanToken = rawAvail.replace(/^schema\.org\/?/, '');
              offer.availability = `${canonicalPrefix}${cleanToken}`;
              warnings.push(`Offer ${i + 1}: <code>availability</code> short token detected.`);
              fixes.push(`Enriched <code>availability</code> to <code>${offer.availability}</code>`);
            }
          }
        });
      }

      return { issues, warnings, fixes, enrichedObj: obj };
    }

    // 4. Output Renderers
    function renderFormattedOutput(jsonObj, title = 'Output', report = null) {
      const jsonStr = JSON.stringify(jsonObj, null, 2);
      const lines = jsonStr.split('\n');
      let tableRows = '';
      lines.forEach((line, index) => {
        const escaped = line
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g, function (match) {
            let cls = 'token-number';
            if (/^"/.test(match)) {
              cls = /:$/.test(match) ? 'token-key' : 'token-string';
            } else if (/true|false/.test(match)) {
              cls = 'token-boolean';
            } else if (/null/.test(match)) {
              cls = 'token-null';
            }
            return `<span class="${cls}">${match}</span>`;
          });

        tableRows += `
          <tr class="aptdot-output-row">
            <td class="aptdot-output-num">${index + 1}</td>
            <td class="aptdot-output-text">${escaped}</td>
          </tr>`;
      });

      let reportHTML = '';
      if (report) {
        let notices = [];
        if (report.fixes && report.fixes.length > 0) {
          notices.push(`<div style="color: #7ee787;"><strong>✨ Auto-Enrichment Applied:</strong><br>• ${report.fixes.join('<br>• ')}</div>`);
        }
        if (report.warnings && report.warnings.length > 0) {
          notices.push(`<div style="color: #ffa657; margin-top: 6px;"><strong>⚠️ Schema Recommendations:</strong><br>• ${report.warnings.join('<br>• ')}</div>`);
        }
        if (report.issues && report.issues.length > 0) {
          notices.push(`<div style="color: #ff7b72; margin-top: 6px;"><strong>❌ Semantic Issues:</strong><br>• ${report.issues.join('<br>• ')}</div>`);
        }
        if (notices.length > 0) {
          reportHTML = `<div class="aptdot-report-box" style="margin: 12px; padding: 12px; background: #21262d; border-radius: 6px; border-left: 4px solid #58a6ff;">${notices.join('')}</div>`;
        }
      }

      jsonOutput.innerHTML = `
        <div class="aptdot-panel-header" style="display: flex; justify-content: space-between; align-items: center; padding: 10px 14px; background: #21262d; border-bottom: 1px solid #30363d;">
          <span class="aptdot-panel-title" style="font-weight: 600; color: #fff;">✅ ${title}</span>
          <div>
            <button type="button" class="aptdot-tool-btn" id="copyOutputBtn" style="padding: 4px 10px; font-size: 12px; margin-right: 6px;">📋 Copy</button>
            <button type="button" class="aptdot-tool-btn" id="downloadOutputBtn" style="padding: 4px 10px; font-size: 12px;">💾 Download .json</button>
          </div>
        </div>
        ${reportHTML}
        <table class="aptdot-output-table" style="width: 100%; border-collapse: collapse; font-family: monospace; font-size: 13px;">${tableRows}</table>`;

      attachExportHandlers(jsonStr, 'schema.json', 'application/json');
      saveToHistory(jsonStr);
    }

    function renderRawTextOutput(text, title = 'Output', fileExt = 'txt') {
      const lines = text.split('\n');
      let tableRows = '';
      lines.forEach((line, index) => {
        const escaped = line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        tableRows += `
          <tr class="aptdot-output-row">
            <td class="aptdot-output-num">${index + 1}</td>
            <td class="aptdot-output-text">${escaped}</td>
          </tr>`;
      });

      jsonOutput.innerHTML = `
        <div class="aptdot-panel-header" style="display: flex; justify-content: space-between; align-items: center; padding: 10px 14px; background: #21262d; border-bottom: 1px solid #30363d;">
          <span class="aptdot-panel-title" style="font-weight: 600; color: #fff;">📄 ${title}</span>
          <div>
            <button type="button" class="aptdot-tool-btn" id="copyOutputBtn" style="padding: 4px 10px; font-size: 12px; margin-right: 6px;">📋 Copy</button>
            <button type="button" class="aptdot-tool-btn" id="downloadOutputBtn" style="padding: 4px 10px; font-size: 12px;">💾 Download .${fileExt}</button>
          </div>
        </div>
        <table class="aptdot-output-table" style="width: 100%; border-collapse: collapse; font-family: monospace; font-size: 13px;">${tableRows}</table>`;

      attachExportHandlers(text, `converted.${fileExt}`, 'text/plain');
    }

    function attachExportHandlers(content, fileName, mimeType) {
      document.getElementById('copyOutputBtn')?.addEventListener('click', () => {
        navigator.clipboard.writeText(content).then(() => alert('Copied to clipboard!'));
      });

      document.getElementById('downloadOutputBtn')?.addEventListener('click', () => {
        const blob = new Blob([content], { type: mimeType });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        a.click();
        URL.revokeObjectURL(url);
      });
    }

    // 5. Converters
    function jsonToXml(obj, rootName = 'root', indent = '') {
      let xml = '';
      if (Array.isArray(obj)) {
        obj.forEach(item => {
          xml += `${indent}<item>\n${jsonToXml(item, '', indent + '  ')}${indent}</item>\n`;
        });
      } else if (typeof obj === 'object' && obj !== null) {
        for (const key in obj) {
          const safeKey = key.replace(/^@/, '').replace(/[^a-zA-Z0-9_\-]/g, '_');
          if (typeof obj[key] === 'object' && obj[key] !== null) {
            xml += `${indent}<${safeKey}>\n${jsonToXml(obj[key], '', indent + '  ')}${indent}</${safeKey}>\n`;
          } else {
            const val = obj[key] === null ? '' : String(obj[key]).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            xml += `${indent}<${safeKey}>${val}</${safeKey}>\n`;
          }
        }
      } else {
        xml += `${indent}${obj}\n`;
      }
      return rootName ? `<?xml version="1.0" encoding="UTF-8"?>\n<${rootName}>\n${xml}</${rootName}>` : xml;
    }

    // Pydantic v2 Compliant Python Model Generator with Keyword & Alias Protection
    function jsonToPython(obj) {
      const pythonKeywords = new Set([
        'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await',
        'break', 'class', 'continue', 'def', 'del', 'elif', 'else', 'except',
        'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is',
        'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try',
        'while', 'with', 'yield'
      ]);

      const sample = Array.isArray(obj) ? (obj[0] || {}) : obj;
      const keys = Object.keys(sample);

      let needsField = false;
      const fields = [];

      keys.forEach(key => {
        const val = sample[key];
        let type = 'Any';
        if (typeof val === 'string') type = 'str';
        else if (typeof val === 'number') type = Number.isInteger(val) ? 'int' : 'float';
        else if (typeof val === 'boolean') type = 'bool';
        else if (Array.isArray(val)) type = 'List[Any]';
        else if (typeof val === 'object' && val !== null) type = 'dict';

        let safeKey = key.replace(/[^a-zA-Z0-9_]/g, '_');
        if (/^[0-9]/.test(safeKey)) safeKey = '_' + safeKey;

        const isKeyword = pythonKeywords.has(safeKey);
        if (isKeyword) {
          safeKey = safeKey + '_';
        }

        const isAliased = isKeyword || (safeKey !== key);
        if (isAliased) needsField = true;

        fields.push({
          safeKey,
          type,
          isAliased,
          originalKey: key
        });
      });

      let py = 'from typing import Any, List, Optional\n';
      py += needsField ? 'from pydantic import BaseModel, Field, ConfigDict\n\n' : 'from pydantic import BaseModel\n\n';
      py += 'class AutoGeneratedModel(BaseModel):\n';

      if (fields.length === 0) {
        py += '    pass\n';
      } else {
        fields.forEach(f => {
          if (f.isAliased) {
            py += `    ${f.safeKey}: Optional[${f.type}] = Field(default=None, alias="${f.originalKey}")\n`;
          } else {
            py += `    ${f.safeKey}: Optional[${f.type}] = None\n`;
          }
        });

        if (needsField) {
          py += '\n    model_config = ConfigDict(populate_by_name=True)\n';
        }
      }

      return py;
    }

    // GFM Compliant Markdown Table Generator with Line Break (<br>) & Pipe Escaping
    function jsonToMarkdown(obj) {
      const items = Array.isArray(obj) ? obj : [obj];
      if (items.length === 0 || typeof items[0] !== 'object' || items[0] === null) {
        let valStr = JSON.stringify(obj);
        valStr = String(valStr ?? '').replace(/\r?\n/g, '<br>').replace(/\|/g, '\\|');
        return '| Value |\n| --- |\n| ' + valStr + ' |';
      }

      const headers = Object.keys(items[0]);
      let md = '| ' + headers.join(' | ') + ' |\n';
      md += '| ' + headers.map(() => '---').join(' | ') + ' |\n';

      items.forEach(row => {
        const rowVals = headers.map(h => {
          const val = row[h];
          let text = typeof val === 'object' && val !== null 
            ? JSON.stringify(val) 
            : String(val ?? '');
          return text.replace(/\r?\n/g, '<br>').replace(/\|/g, '\\|');
        });
        md += '| ' + rowVals.join(' | ') + ' |\n';
      });
      return md;
    }

    // 6. History Management
    function saveToHistory(raw) {
      if (!raw || raw.length < 5) return;
      let history = JSON.parse(localStorage.getItem('aptdot_json_history') || '[]');
      const preview = raw.substring(0, 35).replace(/\n/g, ' ') + '...';
      history = history.filter(item => item.data !== raw);
      history.unshift({ label: `${new Date().toLocaleTimeString()} - ${preview}`, data: raw });
      if (history.length > 5) history.pop();
      localStorage.setItem('aptdot_json_history', JSON.stringify(history));
      refreshHistoryDropdown();
    }

    function refreshHistoryDropdown() {
      if (!historySelect) return;
      const history = JSON.parse(localStorage.getItem('aptdot_json_history') || '[]');
      historySelect.innerHTML = `<option value="" disabled selected>🕒 Recent History (${history.length})</option>`;
      history.forEach((item, idx) => {
        const opt = document.createElement('option');
        opt.value = idx;
        opt.textContent = item.label;
        historySelect.appendChild(opt);
      });
    }
    refreshHistoryDropdown();

    historySelect?.addEventListener('change', function () {
      const history = JSON.parse(localStorage.getItem('aptdot_json_history') || '[]');
      if (history[this.value]) {
        jsonInput.value = history[this.value].data;
        updateGutter();
      }
    });

    // 7. Global Workbench Action Event Listener
    document.addEventListener('click', function (e) {
      const btn = e.target.closest('.aptdot-tool-btn[data-workbench-action]');
      if (!btn) return;

      e.preventDefault();
      const action = btn.getAttribute('data-workbench-action');
      const raw = jsonInput.value.trim();

      if (action === 'clear') {
        jsonInput.value = '';
        jsonOutput.innerHTML = '<div class="aptdot-placeholder-text">Output will render here after clicking an action...</div>';
        updateGutter();
        return;
      }

      if (!raw) {
        alert('Please enter or paste JSON data first.');
        return;
      }

      try {
        let cleanRaw = sanitizeRawJSON(raw);
        let parsed = JSON.parse(cleanRaw);

        if (action === 'validate' || action === 'format') {
          if (modeSelect && modeSelect.value === 'jsonld') {
            const report = inspectSchemaSemantics(parsed);
            renderFormattedOutput(report.enrichedObj, 'Validated & Schema Enriched', report);
          } else {
            renderFormattedOutput(parsed, 'Formatted JSON');
          }
        } 
        else if (action === 'minify') {
          renderRawTextOutput(JSON.stringify(parsed), 'Minified JSON String', 'json');
        }
        else if (action === 'csv') {
          // RFC 4180 Compliant CSV Serializer (Correctly quotes nested structures and strings)
          const items = Array.isArray(parsed) ? parsed : [parsed];
          const headers = Object.keys(items[0] || {});
          
          const csvRows = [headers.map(h => `"${String(h).replace(/"/g, '""')}"`).join(',')];
          
          items.forEach(row => {
            const rowValues = headers.map(header => {
              const val = row[header];
              if (val === undefined || val === null) return '""';
              const str = typeof val === 'object' ? JSON.stringify(val) : String(val);
              return `"${str.replace(/"/g, '""')}"`;
            });
            csvRows.push(rowValues.join(','));
          });
          renderRawTextOutput(csvRows.join('\n'), 'Exported CSV', 'csv');
        }
        else if (action === 'ts') {
          let ts = 'export interface AutoGeneratedType {\n';
          const sample = Array.isArray(parsed) ? parsed[0] || {} : parsed;
          for (const key in sample) {
            const val = sample[key];
            let tsType = 'any';
            
            if (val === null) {
              tsType = 'null';
            } else if (Array.isArray(val)) {
              if (val.length === 0) {
                tsType = 'any[]';
              } else {
                const innerType = val[0] === null ? 'null' : typeof val[0];
                tsType = `${innerType === 'object' ? 'Record<string, any>' : innerType}[]`;
              }
            } else if (typeof val === 'object') {
              tsType = 'Record<string, any>';
            } else {
              tsType = typeof val;
            }
            
            ts += `  ${key}: ${tsType};\n`;
          }
          ts += '}';
          renderRawTextOutput(ts, 'TypeScript Interfaces', 'ts');
        }
        else if (action === 'yaml') {
          let yaml = '';
          for (const key in parsed) {
            yaml += `${key}: ${JSON.stringify(parsed[key])}\n`;
          }
          renderRawTextOutput(yaml, 'Converted YAML', 'yaml');
        }
        else if (action === 'xml') {
          const xmlOutput = jsonToXml(parsed, 'root');
          renderRawTextOutput(xmlOutput, 'Converted XML', 'xml');
        }
        else if (action === 'python') {
          const pyOutput = jsonToPython(parsed);
          renderRawTextOutput(pyOutput, 'Python Pydantic Model', 'py');
        }
        else if (action === 'md') {
          const mdOutput = jsonToMarkdown(parsed);
          renderRawTextOutput(mdOutput, 'Markdown Table', 'md');
        }
        else if (action === 'base64') {
          renderRawTextOutput(btoa(unescape(encodeURIComponent(raw))), 'Base64 Encoded Payload', 'txt');
        }
      } catch (err) {
        jsonOutput.innerHTML = `
          <div class="aptdot-report-box" style="margin: 12px; background: #261c0e; border-left: 4px solid #f85149; color: #ff7b72; padding: 12px; border-radius: 6px;">
            <strong>❌ Unrecoverable Syntax Error:</strong><br>
            ${err.message}<br><br>
            <em>Tip: Input must be valid JSON starting with <code>{</code> or <code>[</code>. Non-JSON formats (like raw CSV or plain text) cannot be parsed.</em>
          </div>`;
      }
    });

    // 8. CORS-Safe Fetch URL
    fetchUrlBtn?.addEventListener('click', async function () {
      const url = prompt('Enter a public JSON URL or API endpoint:');
      if (!url) return;

      try {
        jsonInput.value = 'Fetching data...';
        let response;
        try {
          response = await fetch(url);
        } catch (corsErr) {
          response = await fetch(`https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`);
        }

        if (!response.ok) throw new Error(`HTTP error ${response.status}`);
        const data = await response.text();
        jsonInput.value = data;
        updateGutter();
      } catch (err) {
        alert(`Failed to fetch URL: ${err.message}`);
        jsonInput.value = '';
        updateGutter();
      }
    });

    // 9. Share Link Generator
    shareUrlBtn?.addEventListener('click', function () {
      const raw = jsonInput.value.trim();
      if (!raw) {
        alert('Please enter some JSON to generate a shareable link.');
        return;
      }

      try {
        const encoded = btoa(unescape(encodeURIComponent(raw)));
        const shareUrl = `${window.location.origin}${window.location.pathname}?data=${encoded}`;
        navigator.clipboard.writeText(shareUrl).then(() => {
          alert('Shareable link copied to clipboard!');
        });
      } catch (e) {
        alert('Payload is too large for URL sharing.');
      }
    });

    // 10. Mock Data Dropdown Presets
    mockSelect?.addEventListener('change', function () {
      const val = this.value;
      if (val === 'users') {
        jsonInput.value = JSON.stringify([
          { id: 1, name: "Alice Johnson", role: "Frontend Dev", active: true },
          { id: 2, name: "Bob Smith", role: "Backend Engineer", active: false }
        ], null, 2);
      } else if (val === 'products') {
        jsonInput.value = JSON.stringify([
          { sku: "PROD-101", title: "Wireless Mouse", price: 29.99, stock: 120 },
          { sku: "PROD-102", title: "Mechanical Keyboard", price: 89.50, stock: 45 }
        ], null, 2);
      } else if (val === 'geo') {
        jsonInput.value = JSON.stringify({
          city: "Chandigarh",
          lat: 30.7333,
          lng: 76.7794,
          timezone: "Asia/Kolkata"
        }, null, 2);
      }
      updateGutter();
      this.value = "";
    });

    // 11. File Upload with Extension Guard
    fileInput?.addEventListener('change', function () {
      if (this.files && this.files[0]) {
        const file = this.files[0];
        const fileName = file.name.toLowerCase();

        if (!fileName.endsWith('.json') && !fileName.endsWith('.jsonld') && !fileName.endsWith('.txt')) {
          alert(`Note: "${file.name}" is not a standard JSON file. If this file contains CSV/YAML data, it will not validate as JSON.`);
        }

        const reader = new FileReader();
        reader.onload = (e) => {
          jsonInput.value = e.target.result;
          updateGutter();
        };
        reader.readAsText(file);
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAptdotJsonSuite);
  } else {
    initAptdotJsonSuite();
  }
})();
