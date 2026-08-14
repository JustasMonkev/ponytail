#!/usr/bin/env node
// Parity harness: prints the Node implementation's instruction payloads as JSON
// so the Go test can compare them byte-for-byte. Not shipped — test fixture only.

const {
  getPonytailInstructions,
  getSubagentInstructions,
  getFallbackInstructions,
  filterSkillBodyForMode,
} = require(process.argv[2] + '/hooks/ponytail-instructions.js');

const fs = require('fs');
const mode = process.argv[3] || '';
const skillBody = fs.readFileSync(process.argv[2] + '/skills/ponytail/SKILL.md', 'utf8');

process.stdout.write(JSON.stringify({
  instructions: getPonytailInstructions(mode),
  subagent: getSubagentInstructions(mode),
  fallback: getFallbackInstructions(mode),
  filtered: filterSkillBodyForMode(skillBody, mode),
}));
