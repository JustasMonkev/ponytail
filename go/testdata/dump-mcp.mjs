#!/usr/bin/env node
// Parity harness for the MCP mode resolution. Imports ponytail-mcp/instructions.js
// directly, which is SDK-free, so this runs without npm install. Test fixture only.

import { pathToFileURL } from "node:url";

const root = process.argv[2];
const { MODES, resolveMode, buildInstructions } = await import(
  pathToFileURL(root + "/ponytail-mcp/instructions.js").href
);

const requested = process.argv[3] ?? "";
process.stdout.write(JSON.stringify({
  modes: MODES,
  resolved: resolveMode(requested),
  instructions: buildInstructions(requested),
}));
