#!/usr/bin/env node
/**
 * build-sea.mjs — build Single Executable Application (SEA) binaries.
 *
 *   node scripts/build-sea.mjs [--output-dir <dir>] [--tool <name>]
 *
 * Node 22's built-in SEA support bundles the JS source and a Node runtime
 * into one native binary. No external dependencies, no build tools — the
 * same zero-dependency property the rest of this package maintains.
 *
 * Each tool in src/ becomes a standalone binary. The unified `macho-explorer`
 * dispatcher is NOT built as a SEA binary because it uses dynamic imports
 * to load subcommands, which SEA's bundler cannot follow. It remains
 * available as a Node.js script for npm users.
 *
 * Output naming: <tool>-<platform>-<arch>[.exe]
 *   describe-darwin-arm64, describe-linux-x64, describe-win-x64.exe, ...
 *
 * On Windows, the output is a .exe; on macOS and Linux, no extension.
 *
 * Exit codes:
 *   0  success
 *   1  build failed
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// Parse args
const args = process.argv.slice(2);
let outputDir = path.join(ROOT, 'dist');
let onlyTool = null;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--output-dir' && args[i + 1]) {
    outputDir = path.resolve(args[++i]);
  } else if (args[i] === '--tool' && args[i + 1]) {
    onlyTool = args[++i];
  }
}

// All tools that get a SEA binary (excludes macho-explorer dispatcher)
const TOOLS = [
  'describe', 'overview', 'sym', 'symlookup',
  'findcall', 'findliteral', 'mapliteral', 'a2o', 'o2a',
  'dump', 'starts', 'assert', 'disasm', 'audit', 'fingerprint', 'diff', 'mcp',
];

const toolsToBuild = onlyTool ? [onlyTool] : TOOLS;

// Platform/arch suffix
function platformSuffix() {
  const platform = process.platform;
  const arch = process.arch;
  if (platform === 'darwin') return `darwin-${arch}`;
  if (platform === 'win32') return `win-${arch}`;
  return `${platform}-${arch}`;
}

function outputName(tool) {
  const suffix = platformSuffix();
  const ext = process.platform === 'win32' ? '.exe' : '';
  return `${tool}-${suffix}${ext}`;
}

// Build a SEA binary for a single tool
function buildSEA(tool) {
  const entryPoint = path.join(ROOT, 'src', `${tool}.mjs`);
  if (!fs.existsSync(entryPoint)) {
    console.error(`error: entry point not found: ${entryPoint}`);
    process.exit(1);
  }

  const nodeBin = process.execPath;
  const blobPath = path.join(outputDir, `sea-prep-${tool}.blob`);
  const configPath = path.join(outputDir, `sea-config-${tool}.json`);
  const outPath = path.join(outputDir, outputName(tool));

  // SEA config
  //
  // `package.json` is embedded as an asset so the binary reports its own real
  // version. `src/version.mjs` reads it back through `node:sea`; without the
  // asset it would have nothing to read, and the two tools that name the
  // version in their output (`mcp`, and SARIF) would fail to start rather
  // than answer. The version therefore cannot disagree with the tag.
  const config = {
    main: entryPoint,
    output: blobPath,
    disableExperimentalSEAWarning: true,
    assets: {
      'macho-explorer-package.json': path.join(ROOT, 'package.json'),
    },
  };

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

  // Step 1: Generate the SEA blob
  console.log(`  generating blob for ${tool}...`);
  try {
    execFileSync(nodeBin, ['--experimental-sea-config', configPath], {
      stdio: 'pipe',
      cwd: ROOT,
    });
  } catch (err) {
    console.error(`  error generating blob for ${tool}: ${err.message}`);
    return false;
  }

  // Step 2: Copy the node binary
  console.log(`  copying node binary for ${tool}...`);
  fs.copyFileSync(nodeBin, outPath);

  // Step 3: Inject the blob using postject
  console.log(`  injecting blob into ${tool}...`);
  try {
    execFileSync('npx', ['--yes', 'postject', outPath, 'NODE_SEA_BLOB', blobPath, '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'], {
      stdio: 'pipe',
      cwd: ROOT,
    });
  } catch (err) {
    console.error(`  error injecting blob for ${tool}: ${err.message}`);
    return false;
  }

  // Cleanup temp files
  try { fs.unlinkSync(blobPath); } catch {}
  try { fs.unlinkSync(configPath); } catch {}

  // Make executable on Unix
  if (process.platform !== 'win32') {
    try { fs.chmodSync(outPath, 0o755); } catch {}
  }

  const sizeMB = (fs.statSync(outPath).size / 1024 / 1024).toFixed(1);
  console.log(`  built ${outputName(tool)} (${sizeMB} MB)`);
  return true;
}

// Main
console.log(`Building SEA binaries for ${toolsToBuild.length} tool(s)...`);
console.log(`Output directory: ${outputDir}`);
console.log(`Platform: ${process.platform}-${process.arch}`);
console.log('');

fs.mkdirSync(outputDir, { recursive: true });

let failed = 0;
for (const tool of toolsToBuild) {
  console.log(`Building ${tool}...`);
  if (!buildSEA(tool)) {
    failed++;
  }
  console.log('');
}

if (failed > 0) {
  console.error(`${failed} build(s) failed.`);
  process.exit(1);
}

console.log(`All ${toolsToBuild.length} binary(ies) built successfully.`);
