#!/usr/bin/env node
/**
 * adapter.mjs — the reference conformance adapter, built on this reader.
 *
 * The conformance runner invokes an adapter as `<command> <path-to-binary>` and
 * reads one JSON record from stdout. This is that adapter for MachO-explorer, and
 * it exists to do two things: prove the interface is satisfiable, and give a
 * consumer a worked example to copy when they wire up MachOKit, `go-macho`, LIEF,
 * `ipsw` or their own parser.
 *
 *   node conformance/adapter.mjs test/fixtures/universal.macho
 */

import { describe } from '../src/api.mjs';
import { normalize } from './record.mjs';

const path = process.argv[2];
if (!path) {
  process.stderr.write('usage: node conformance/adapter.mjs <path-to-mach-o>\n');
  process.exit(2);
}
process.stdout.write(JSON.stringify(normalize(describe(path))));
