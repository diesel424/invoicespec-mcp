# InvoiceSpec MCP Server (`invoicespec-mcp`)

Official **Model Context Protocol (MCP)** server for European B2B & B2G E-Invoicing (**Peppol BIS 3.0**, **EN 16931**, **German XRechnung 3.0**, **ZUGFeRD 2.3**, **French Factur-X**, **Polish KSeF FA(2)**, and **Italian FatturaPA**).

Give Claude Desktop, Cursor, Windsurf, or any MCP-compatible AI agent instant access to:
1. **`lookup_peppol_participant`** — Live EU Peppol Directory lookup (Participant ID + BIS 3.0 check + ready-to-paste `<cbc:EndpointID>` XML).
2. **`search_en16931_rules`** — Search 1,156 Schematron error codes (`BR-CO-10`, `BR-DE-15`, `PEPPOL-EN16931-R008`, `KSeF`).
3. **`validate_eu_invoice_xml`** — 100% local, zero-retention UBL 2.1 / CII / KSeF XML validation.
4. **`normalize_or_compile_invoice`** — Auto-fix broken XML or compile Stripe/Shopify JSON into Peppol UBL / ZUGFeRD CII via [invoicespec.dev](https://invoicespec.dev).

## Quick Setup (Claude Desktop / Cursor)

Add this to your `claude_desktop_config.json` or `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "invoicespec": {
      "command": "npx",
      "args": ["-y", "invoicespec-mcp"],
      "env": {
        "INVOICESPEC_API_KEY": "isk_live_OPTIONAL_FOR_AUTOFIX"
      }
    }
  }
}
```

> Free tools (`lookup_peppol_participant`, `search_en16931_rules`, `validate_eu_invoice_xml`) work with **zero API key**. Get an `isk_live_*` key at **https://invoicespec.dev** for automated XML normalization & Stripe/Shopify JSON compilation.
