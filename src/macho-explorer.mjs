#!/usr/bin/env node
/**
 * macho-explorer.mjs — unified CLI for Mach-O binary introspection.
 *
 *   macho-explorer <subcommand> [args...]
 *
 * This is the single entry point for all Mach-O exploration tools. Each
 * subcommand maps to a tool file in src/ and supports the same standardized
 * flags.
 *
 * Subcommands:
 *   describe      What is in this binary?
 *   overview      Whole structural picture in one call
 *   sym           Search symbol table
 *   symlookup     vaddr-to-function lookup
 *   findcall      Direct call/jmp xrefs
 *   findliteral   Byte literal search / string listing
 *   mapliteral    Literal-to-address-to-pointers mapping
 *   a2o           Address-to-file-offset
 *   o2a           File-offset-to-address
 *   disasm        Instruction boundary/branch decoding
 *   audit         Structural consistency check
 *   fingerprint   Program identity fingerprinting
 *   diff          Structural diff between two binaries
 *   mcp           MCP server (JSON-RPC over stdin/stdout)
 *
 * Global options (accepted by every subcommand):
 *   -h, --help      Show help
 *   -V, --version   Show version
 *   -q, --quiet     Suppress non-essential output
 *   --color         Force color output
 *   --no-color      Disable color output
 *   -v, --verbose   Diagnostic output
 *
 * Exit codes:
 *   0  ran, found something
 *   1  ran, found nothing (negative answer, not an error)
 *   2  usage error
 *   3  could not do the job (unreadable file, unparseable Mach-O)
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Read version from package.json
const pkg = JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

const SUBCOMMANDS = [
  'describe', 'overview', 'sym', 'symlookup', 'findcall', 'findliteral',
  'mapliteral', 'a2o', 'o2a', 'dump', 'starts', 'assert', 'disasm', 'audit',
  'fingerprint', 'diff', 'tbd', 'symbolicate', 'mcp',
];

const HELP = [
  'usage: macho-explorer <subcommand> [args...]',
  '',
  'Mach-O binary introspection for Apple binaries.',
  '',
  'start here',
  '  describe      What is in this binary: slices, arch, symbol counts, __TEXT',
  '  overview      The whole picture in one call — structure + symbols + strings',
  '',
  'symbols & names',
  '  sym           Search the symbol table by name',
  '  symlookup     Which function contains this address',
  '  symbolicate   Crash-report addresses to functions',
  '',
  'addresses & code',
  '  a2o           Address -> file offset',
  '  o2a           File offset -> address',
  '  findcall      Direct call/jmp references to an address',
  '  findliteral   Byte literal search / list C strings',
  '  mapliteral    Literal -> addresses -> pointers that reference it',
  '  disasm        Instruction boundaries and branch targets',
  '',
  'verify & compare',
  '  audit         Structural consistency check (a CI gate)',
  '  fingerprint   Program identity fingerprint',
  '  diff          Structural diff between two binaries',
  '  dump          Bytes at a virtual address',
  '  starts        Function entry points',
  '  assert        Assert structural facts about a binary',
  '',
  'integrate',
  '  mcp           MCP server (JSON-RPC over stdin/stdout)',
  '  tbd           Text stub (.tbd): exported symbols of a dylib',
  '',
  'examples:',
  '  macho-explorer describe /bin/ls                  what is this file?',
  '  macho-explorer sym main /usr/local/go/bin/go     find a symbol by name',
  '  macho-explorer findcall --list /bin/ls 20        the busiest call sites',
  '  macho-explorer audit --json MyApp.app | jq .ok   gate CI on structure',
  '',
  'global options (every subcommand accepts these):',
  '  -h, --help      Show this help',
  '  -V, --version   Show version',
  '  -q, --quiet     Suppress non-essential output',
  '  --color         Force color output',
  '  --no-color      Disable color output',
  '  -v, --verbose   Diagnostic output',
  '',
  'Run `macho-explorer <subcommand> --help` for subcommand-specific options.',
  '',
  'exit codes:',
  '  0  ran, found something',
  '  1  ran, found nothing (negative answer, not an error)',
  '  2  usage error',
  '  3  could not do the job (unreadable file, unparseable Mach-O)',
];

const args = process.argv.slice(2);

// Handle global flags before subcommand
if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
  process.stdout.write(HELP.join('\n') + '\n');
  process.exit(0);
}

if (args[0] === '--version' || args[0] === '-V') {
  process.stdout.write(`macho-explorer ${pkg.version}\n`);
  process.exit(0);
}

const subcommand = args[0];
const subcommandArgs = args.slice(1);

// Validate subcommand
if (!SUBCOMMANDS.includes(subcommand)) {
  // Check for near-miss
  let hint = '';
  let best = null;
  for (const cmd of SUBCOMMANDS) {
    const d = levenshtein(subcommand, cmd);
    if (d <= Math.max(1, Math.floor(subcommand.length / 3)) && (!best || d < best.d)) {
      best = { cmd, d };
    }
  }
  if (best) hint = `\n\n  did you mean ${best.cmd}?`;

  process.stderr.write(
    `macho-explorer: unknown subcommand: ${subcommand}${hint}\n\n` +
    `  run \`macho-explorer --help\` for available subcommands.\n`
  );
  process.exit(2);
}

// Dispatch to subcommand by modifying process.argv and dynamically importing
const toolPath = path.resolve(__dirname, `${subcommand}.mjs`);
process.argv = [process.argv[0], toolPath, ...subcommandArgs];
// `pathToFileURL`, not the bare path: `import()` accepts a bare absolute path on
// POSIX only by accident, and on Windows `D:\...\describe.mjs` is parsed as a URL
// with an unsupported `d:` scheme, so every subcommand failed to load with
// ERR_UNSUPPORTED_ESM_URL_SCHEME. A file URL is the one specifier form that means
// the same thing on every platform this package claims to run on.
await import(pathToFileURL(toolPath).href);

/** Plain Levenshtein, no early exit. Inputs are a handful of characters. */
function levenshtein(a, b) {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}
