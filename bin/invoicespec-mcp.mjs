#!/usr/bin/env node
/**
 * InvoiceSpec Official MCP Server (Zero-Dependency JSON-RPC 2.0 over stdio)
 * Protocol: Model Context Protocol (2024-11-05)
 * Website: https://invoicespec.dev
 */
import readline from 'node:readline';

const API_BASE = 'https://invoicespec.dev';
const SERVER_INFO = {
  name: 'invoicespec-mcp',
  version: '1.0.0',
};

const TOOLS = [
  {
    name: 'lookup_peppol_participant',
    description:
      'Search the official European Peppol Directory by company name, VAT ID, or Participant ID. Returns registered Peppol Participant IDs, BIS 3.0 Invoice support status, and ready-to-paste <cbc:EndpointID> UBL XML snippets.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Company name, VAT number, or Peppol ID (e.g. "Proximus", "BE0202239951", "Siemens").',
        },
        country: {
          type: 'string',
          description: 'Optional 2-letter ISO country code filter (e.g. "BE", "DE", "FR", "PL", "NL").',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'search_en16931_rules',
    description:
      'Search 1,156 European e-invoicing Schematron validation rules across Peppol BIS 3.0, EN 16931, German XRechnung 3.0, ZUGFeRD 2.3, French Factur-X, Polish KSeF FA(2), and Italian FatturaPA.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Rule code or keyword (e.g. "BR-CO-10", "BR-DE-15", "PEPPOL-EN16931-R008", "Leitweg-ID", "KSeF").',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of matching rules to return (default: 10, max: 25).',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'validate_eu_invoice_xml',
    description:
      'Validate a UBL 2.1, UN/CEFACT CII, XRechnung 3.0, ZUGFeRD 2.3, or Polish KSeF FA(2) XML invoice locally with zero data retention. Detects syntax, checks mandatory Business Terms (BT-5, BT-10, BT-24, BT-34), empty XML elements (R008), and BR-CO-10 line-item net sum math.',
    inputSchema: {
      type: 'object',
      properties: {
        xml: {
          type: 'string',
          description: 'Raw XML content of the EU e-invoice.',
        },
      },
      required: ['xml'],
    },
  },
  {
    name: 'normalize_or_compile_invoice',
    description:
      'Auto-fix EN 16931 / Peppol XML errors or compile Stripe/Shopify JSON into compliant Peppol BIS 3.0 (UBL 2.1) or ZUGFeRD 2.3 (CII) XML via https://invoicespec.dev/api/v1/normalize. Requires an InvoiceSpec API key (INVOICESPEC_API_KEY env var or api_key parameter).',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['normalize_xml', 'convert_json'],
          description: 'Use "normalize_xml" to auto-fix XML, or "convert_json" to compile Stripe/Shopify JSON.',
        },
        target_format: {
          type: 'string',
          enum: ['peppol-ubl', 'zugferd-cii'],
          description: 'Target XML standard (default: "peppol-ubl").',
        },
        xml: {
          type: 'string',
          description: 'XML invoice payload (when action is "normalize_xml").',
        },
        erp_json: {
          type: 'object',
          description: 'Stripe invoice or Shopify order JSON object (when action is "convert_json").',
        },
        api_key: {
          type: 'string',
          description: 'Optional isk_live_* API key (falls back to INVOICESPEC_API_KEY environment variable).',
        },
      },
      required: ['action'],
    },
  },
];

function validateXmlLocally(xml) {
  const issues = [];
  const trimmed = String(xml || '').trim();
  if (!trimmed.startsWith('<')) {
    return {
      valid: false,
      syntax: 'INVALID',
      issues: [{ code: 'XML-SYNTAX', severity: 'fatal', message: 'Input does not start with an XML tag.' }],
    };
  }

  let syntax = 'UBL-2.1';
  if (/CrossIndustryInvoice/i.test(trimmed)) syntax = 'CII-D16B';
  else if (/<Faktura[\s>]/i.test(trimmed) && /crd\.gov\.pl|FA\s*\(2\)/i.test(trimmed)) syntax = 'KSEF-FA2';
  else if (/FatturaElettronica/i.test(trimmed)) syntax = 'FATTURAPA';

  // Empty leaf tags (PEPPOL-EN16931-R008)
  const emptyMatches = [...trimmed.matchAll(/<([a-zA-Z0-9_:-]+)(?:\s[^>]*)?>\s*<\/\1>/g)].map((m) => m[1]);
  if (emptyMatches.length > 0 && syntax !== 'KSEF-FA2') {
    issues.push({
      code: 'PEPPOL-EN16931-R008',
      severity: 'fatal',
      message: `Empty XML element(s) detected: ${emptyMatches.slice(0, 5).join(', ')}`,
      fix: 'Remove empty XML elements or populate with valid values.',
      docs: 'https://invoicespec.dev/errors/peppol-bis-3/peppol-en16931-r008',
    });
  }

  if (syntax === 'UBL-2.1') {
    if (!/<(?:cbc:)?CustomizationID[^>]*>[^<]+<\/(?:cbc:)?CustomizationID>/i.test(trimmed)) {
      issues.push({
        code: 'BR-01',
        severity: 'fatal',
        message: 'Missing Specification Identifier (BT-24 / cbc:CustomizationID).',
        fix: 'Insert <cbc:CustomizationID>urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0</cbc:CustomizationID>.',
        docs: 'https://invoicespec.dev/errors/peppol-bis-3/br-01',
      });
    }

    const currMatch = trimmed.match(/<(?:cbc:)?DocumentCurrencyCode[^>]*>\s*([^<\s]+)\s*<\/(?:cbc:)?DocumentCurrencyCode>/i);
    if (!currMatch || !/^[A-Z]{3}$/.test(currMatch[1])) {
      issues.push({
        code: 'BR-CL-01',
        severity: 'fatal',
        message: `Invalid or missing ISO 4217 uppercase currency code: "${currMatch ? currMatch[1] : 'missing'}".`,
        fix: `Use uppercase 3-letter ISO 4217 currency code (e.g. "${(currMatch?.[1] || 'EUR').toUpperCase()}").`,
        docs: 'https://invoicespec.dev/errors/peppol-bis-3/br-cl-01',
      });
    }

    if (!/<(?:cbc:)?BuyerReference[^>]*>[^<\s]+<\/(?:cbc:)?BuyerReference>/i.test(trimmed)) {
      issues.push({
        code: 'BR-DE-15',
        severity: 'warning',
        message: 'Missing Buyer Reference / Leitweg-ID (BT-10 / cbc:BuyerReference).',
        fix: 'Add <cbc:BuyerReference>991-12345-67</cbc:BuyerReference> or PO reference.',
        docs: 'https://invoicespec.dev/errors/xrechnung-3-0/br-de-15',
      });
    }

    const supplierBlock = trimmed.match(/<(?:cac:)?AccountingSupplierParty[\s\S]*?<\/(?:cac:)?AccountingSupplierParty>/i);
    if (supplierBlock && !/<(?:cbc:)?EndpointID[^>]*>[^<\s]+<\/(?:cbc:)?EndpointID>/i.test(supplierBlock[0])) {
      issues.push({
        code: 'PEPPOL-EN16931-R020',
        severity: 'fatal',
        message: 'Missing Seller Electronic Address (BT-34 / cbc:EndpointID).',
        fix: 'Add <cbc:EndpointID schemeID="EM">billing@company.eu</cbc:EndpointID> inside AccountingSupplierParty.',
        docs: 'https://invoicespec.dev/errors/peppol-bis-3/peppol-en16931-r020',
      });
    }

    // BR-CO-10 Line Net Sum Check
    const lineBlocks = [...trimmed.matchAll(/<(?:cac:)?InvoiceLine[\s\S]*?<\/(?:cac:)?InvoiceLine>/gi)];
    let calcSum = 0;
    for (const lb of lineBlocks) {
      const amt = lb[0].match(/<(?:cbc:)?LineExtensionAmount[^>]*>\s*([-0-9.]+)\s*<\/(?:cbc:)?LineExtensionAmount>/i);
      if (amt) calcSum += parseFloat(amt[1]) || 0;
    }
    const lmtBlock = trimmed.match(/<(?:cac:)?LegalMonetaryTotal[\s\S]*?<\/(?:cac:)?LegalMonetaryTotal>/i);
    if (lmtBlock && lineBlocks.length > 0) {
      const rep = lmtBlock[0].match(/<(?:cbc:)?LineExtensionAmount[^>]*>\s*([-0-9.]+)\s*<\/(?:cbc:)?LineExtensionAmount>/i);
      const repVal = rep ? parseFloat(rep[1]) || 0 : 0;
      if (Math.abs(calcSum - repVal) > 0.005) {
        issues.push({
          code: 'BR-CO-10',
          severity: 'fatal',
          message: `Line net sum mismatch: Header BT-106 (${repVal.toFixed(2)}) != Sum of lines BT-131 (${calcSum.toFixed(2)}).`,
          fix: `Update LegalMonetaryTotal/LineExtensionAmount to ${calcSum.toFixed(2)}.`,
          docs: 'https://invoicespec.dev/errors/peppol-bis-3/br-co-10',
        });
      }
    }
  }

  if (syntax === 'KSEF-FA2') {
    const nip = trimmed.match(/<NIP>\s*([^<\s]+)\s*<\/NIP>/i);
    if (!nip || !/^\d{10}$/.test(nip[1])) {
      issues.push({
        code: 'KSEF-NIP-01',
        severity: 'fatal',
        message: `Invalid 10-digit Polish NIP: "${nip ? nip[1] : 'missing'}".`,
        fix: 'Provide a clean 10-digit Polish NIP without dashes or PL prefix.',
        docs: 'https://invoicespec.dev/pl/ksef-validator',
      });
    }
  }

  const fatalCount = issues.filter((i) => i.severity === 'fatal').length;
  return {
    valid: fatalCount === 0,
    syntax,
    fatalCount,
    warningCount: issues.length - fatalCount,
    issues,
    studioUrl: 'https://invoicespec.dev/#validator',
  };
}

async function handleToolCall(name, args = {}) {
  if (name === 'lookup_peppol_participant') {
    const params = new URLSearchParams({ q: String(args.query || '').trim() });
    if (args.country) params.set('country', String(args.country).trim().toUpperCase());
    const res = await fetch(`${API_BASE}/api/v1/peppol-lookup?${params.toString()}`);
    const data = await res.json();
    return {
      content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
      isError: !res.ok,
    };
  }

  if (name === 'search_en16931_rules') {
    const params = new URLSearchParams({
      q: String(args.query || '').trim(),
      limit: String(Math.min(25, Math.max(1, Number(args.limit || 10)))),
    });
    const res = await fetch(`${API_BASE}/api/v1/rules?${params.toString()}`);
    const data = await res.json();
    return {
      content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
      isError: !res.ok,
    };
  }

  if (name === 'validate_eu_invoice_xml') {
    const report = validateXmlLocally(args.xml);
    return {
      content: [{ type: 'text', text: JSON.stringify(report, null, 2) }],
    };
  }

  if (name === 'normalize_or_compile_invoice') {
    const apiKey = String(args.api_key || process.env.INVOICESPEC_API_KEY || '').trim();
    if (!apiKey) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                ok: false,
                error: 'Missing INVOICESPEC_API_KEY. Get a free isk_live_* key at https://invoicespec.dev',
              },
              null,
              2
            ),
          },
        ],
        isError: true,
      };
    }
    const res = await fetch(`${API_BASE}/api/v1/normalize`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
      },
      body: JSON.stringify({
        action: args.action,
        target_format: args.target_format || 'peppol-ubl',
        xml: args.xml,
        erp_json: args.erp_json,
      }),
    });
    const data = await res.json();
    return {
      content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
      isError: !res.ok,
    };
  }

  return {
    content: [{ type: 'text', text: `Unknown tool: ${name}` }],
    isError: true,
  };
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on('line', async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let req;
  try {
    req = JSON.parse(trimmed);
  } catch {
    return;
  }

  const { id, method, params } = req;

  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      },
    });
    return;
  }

  if (method === 'notifications/initialized') {
    return;
  }

  if (method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id,
      result: { tools: TOOLS },
    });
    return;
  }

  if (method === 'tools/call') {
    try {
      const result = await handleToolCall(params?.name, params?.arguments || {});
      send({ jsonrpc: '2.0', id, result });
    } catch (err) {
      send({
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        },
      });
    }
    return;
  }

  if (id !== undefined) {
    send({
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    });
  }
});
