/**
 * Type declarations for MachO-explorer.
 *
 * Hand-written rather than generated, and deliberately small.
 *
 * `allowJs` + `checkJs` would infer most of this, but inference for a library is
 * a liability: it describes what the code happens to do rather than what it
 * promises, so an internal refactor silently changes the public types and every
 * consumer's build breaks without anyone editing a `.d.ts`. These declarations
 * are the contract, and they are allowed to be narrower than the implementation.
 *
 * Addresses are `bigint` throughout. A 64-bit virtual address does not survive a
 * JavaScript `number` — anything above 2^53 loses its low bits — and a type that
 * said `number` would push every caller into a silent precision loss. JSON output
 * renders them as `"0x..."` strings for the same reason.
 */

/** A 64-bit virtual address or file offset. */
export type Vaddr = bigint;

/** Mach-O and fat-header magic numbers. */
export const MH_MAGIC_64: number;
export const MH_MAGIC_32: number;
export const FAT_MAGIC: number;
export const FAT_CIGAM: number;

/** CPU types this reader names. */
export const CPU_X86_64: number;
export const CPU_ARM64: number;

/** Load commands and symbol-type masks the reader inspects. */
export const LC_SEGMENT: number;
export const LC_SEGMENT_64: number;
export const LC_SYMTAB: number;
export const N_STAB: number;
export const N_TYPE: number;
export const N_SECT: number;

/** Section attribute bits that mark a section as containing instructions. */
export const S_ATTR_PURE_INSTRUCTIONS: number;
export const S_ATTR_SOME_INSTRUCTIONS: number;

/** The four Mach-O magic byte sequences, compared as bytes. */
export const MACHO_MAGICS: Buffer[];

/** Standard exit codes, matching `EXIT` in the implementation. */
export declare const EXIT: {
  readonly ok: 0;
  /** The tool ran and found nothing — deliberately not an error. */
  readonly empty: 1;
  readonly usage: 2;
  readonly fail: 3;
};

/** A bounded, cached reader over an open file. */
export interface Opener {
  /** The underlying file descriptor. */
  fd: number;
  /** File size in bytes. */
  size: number;
  /** The path this handle was opened from. */
  path: string;
  /**
   * Read `len` bytes at absolute file offset `off`. Short reads are returned
   * as-is and never padded, so a read past the end is a zero-length buffer
   * rather than an error.
   */
  read(off: number, len: number): Buffer;
  close(): void;
}

/** Open a file and return a bounded reader with a small read cache. */
export declare function opener(path: string): Opener;

/** True when `p` is a readable file whose first four bytes are a Mach-O magic. */
export declare function isMachOFile(p: string): boolean;

/** A human name for a CPU type, falling back to its raw value. */
export declare function sliceName(cputype: number | null): string;

/**
 * A slice's architecture name, including the `arm64e` distinction.
 *
 * `arm64e` is `CPU_TYPE_ARM64` with a different *subtype*, so `sliceName` cannot
 * see it and every arm64e slice would be reported as plain `arm64`. On iOS that
 * is the difference between a binary that uses pointer authentication and one
 * that does not.
 *
 * `cpusubtype` may be null when a fat slice's record has not been read; the
 * result is then `arm64`, which is a coarser answer rather than a fabricated one.
 */
export declare function sliceArchName(
  cputype: number | null,
  cpusubtype?: number | null,
): string;

/** `CPU_SUBTYPE_ARM64E`, masked past the capability bits in the high byte. */
export declare const CPU_SUBTYPE_ARM64E: number;
/** `CPU_SUBTYPE_ARM64E_V8` — arm64e advertising the v8 ISA. */
export declare const CPU_SUBTYPE_ARM64E_V8: number;
/** A `PLATFORM_*` constant's name, or `platform=<n>` when unknown. */
export declare function platformName(n: number | null): string | null;

/** An `MH_*` filetype's name, or `filetype=<n>` when unknown. */
export declare function filetypeName(n: number | null): string | null;

/**
 * Unpack the `xxxx.yy.zz` nibble encoding used by `minos` and `sdk`.
 *
 * The groups are fixed-width nibbles rather than a decimal fraction, so
 * `0x0d0300` is `13.3.0` — string concatenation would produce `13.30`.
 */
export declare function unpackVersion(v: number | null): string | null;

/** One entry of a fat header. */
export interface FatSlice {
  cputype: number;
  /**
   * The subtype field, byte 4 of the 20-byte `fat_arch`.
   *
   * Only meaningful for architectures that use it — chiefly `arm64e`, which is
   * an `arm64` subtype rather than a cputype of its own.
   */
  cpusubtype: number;
  /** Byte offset of this slice within the *file*. */
  offset: number;
  size: number;
}

/** A slice with its parse result attached. */
export interface Slice extends FatSlice {
  /** True when the file is a single-architecture Mach-O rather than fat. */
  thin: boolean;
}

/** A parsed segment. `vmaddr`/`vmsize` are BigInt because they are 64-bit. */
export interface Segment {
  segname: string;
  vmaddr: bigint;
  vmsize: bigint;
  fileoff: bigint;
  filesize: bigint;
}

/**
 * A parsed section.
 *
 * `offset` is relative to the start of its **slice**, not the start of the file.
 * Reading a section therefore requires the slice's file offset as well; see
 * `codeSections` and the API functions, which handle that.
 */
export interface Section {
  sectname: string;
  segname: string;
  addr: bigint;
  size: number;
  offset: number;
  /**
   * The raw `flags` word, as of `section_64`. Authoritative — the decoded fields
   * below are derived from it and never replace it.
   */
  flags: number;
  /** The section type, from the low 8 bits. `S_UNKNOWN_0x…` if undefined. */
  type: string;
  /** The numeric type, before naming. */
  typeRaw: number;
  /** Section attributes, from the top 24 bits. See {@link Section.type}. */
  attributes: string[];
  /** Attribute bits with no name in `<mach-o/loader.h>`. Zero on a real binary. */
  attributesUnknown: number;
}

/**
 * A header `flags` word, decoded.
 *
 * `unknown` is kept apart from `names` on purpose: a bit that is set and unnamed
 * is either a format newer than this reader or a corrupted header, and folding it
 * in with the absent ones would make both look like an ordinary file.
 */
export interface HeaderFlags {
  flags: number;
  names: string[];
  unknown: number;
}

/** A section `flags` word, decoded into its two disjoint halves. */
export interface DecodedSectionFlags {
  type: string;
  typeRaw: number;
  attributes: string[];
  attributesUnknown: number;
}

/**
 * An `LC_SOURCE_VERSION`, decoded from `a24.b10.c10.d10.e10`.
 *
 * The widths are unequal — `a` is 24 bits and the rest are 10 — so these are
 * BigInts and `text` is the dotted form.
 */
export interface SourceVersion {
  raw: bigint;
  a: bigint;
  b: bigint;
  c: bigint;
  d: bigint;
  e: bigint;
  text: string;
}

/**
 * An `LC_MAIN` entry point, reported as the file offset the header declares.
 *
 * `vaddr` is always `null`, and deliberately. `entryoff` is the raw field; its
 * address is one `a2o` call away. Deriving it here would publish a second,
 * independently-computed answer for the same fact — and two answers that can
 * disagree is the failure this package exists to refuse. See
 * {@link resolveEntryPoint}.
 */
export interface EntryPoint {
  /**
   * The `entryoff` field, as a `uint64`. On the documented 24-byte command — the
   * only form `<mach-o/loader.h>` defines, and the form `0x80000028` carries —
   * this is the file (`__TEXT`) offset of `main`.
   */
  entryoff: bigint;
  /** The `stacksize` field. `null` only if a malformed command omits it. */
  stacksize: bigint | null;
  /** The command's declared size. 24 is the documented (and emitted) form. */
  cmdsize: number;
  /** The upper 32 bits of `entryoff`, disclosed so the raw bytes stay visible. */
  rawHigh32: number;
  /** Which reading was used, and why. */
  valueBasis: string;
  /** Always `null` — see the note on this interface. */
  vaddr: null;
  /** Whether `entryoff` falls inside `__TEXT`. `null` when there is no `__TEXT`. */
  entryoffLandsInText: boolean | null;
  note: string;
}

/** One structural problem found in a slice. Reported alongside the parse. */
export interface Abnormality {
  /** A stable slug, e.g. `strtab-past-slice-end`. Safe to branch on. */
  kind: string;
  /**
   * `error` — the file disagrees with itself, so a reader's answers may be wrong.
   * `warning` — the file parsed and something is unfamiliar or explicitly
   * heuristic. This is what `audit --strict` switches on.
   */
  severity: 'error' | 'warning';
  detail: string;
}

/** One slice's contribution to an {@link audit}. */
export interface AuditSlice {
  arch: string;
  offset: number;
  size: number;
  readable: boolean;
  ncmds?: number;
  nsects?: number;
  nsyms?: number;
  abnormalities: Abnormality[];
}

/** The result of {@link audit} — the verdict a build gate branches on. */
export interface AuditResult {
  path: string;
  size: number;
  fat: boolean;
  strict: boolean;
  slices: AuditSlice[];
  /** Findings about the fat table, kept apart from the per-slice ones. */
  containerAbnormalities: Abnormality[];
  /** Every finding, tagged with the slice it came from (`null` for the container). */
  findings: Array<Abnormality & { slice: string | null }>;
  counts: { total: number; errors: number; warnings: number };
  /** `ok` / `warnings` / `failed` — a label for a person, not the gate. */
  verdict: 'ok' | 'warnings' | 'failed';
  /** No errors. This, not `verdict`, is the default gate. */
  clean: boolean;
  /** No findings at all. The gate when `strict` was asked for. */
  strictClean: boolean;
}

/** How strongly one slice's shape pins a program. */
export type FingerprintTier = 'full' | 'structure-only';

/** One slice's fingerprint. */
export interface SliceFingerprint {
  arch: string;
  fingerprint: string;
  structure: string;
  /** Null when stripped — no names to digest. */
  symbols: string | null;
  tier: FingerprintTier;
  nsyms: number;
  uuid: string | null;
  nsects: number;
  ncmds: number;
}

/** The result of {@link fingerprint}. */
export interface FingerprintResult {
  path: string;
  size: number;
  fat: boolean;
  slices: SliceFingerprint[];
  /** One digest across every slice; null when nothing parsed. */
  fingerprint: string | null;
  /** The single agreeing UUID, or null when absent or disagreeing. */
  uuid: string | null;
  /** The weakest tier present, so a stripped slice is not hidden by a full one. */
  tier: FingerprintTier | null;
}

/** One architecture's row in a {@link compareFingerprints} result. */
export interface FingerprintComparisonRow {
  arch: string;
  presentInBoth: boolean;
  fingerprint: string | null;
  other: string | null;
  /** Null when the architecture is absent on one side — not `false`. */
  match: boolean | null;
  tier: FingerprintTier;
}

/** The result of {@link compareFingerprints} — three questions, three answers. */
export interface FingerprintComparison {
  a: FingerprintResult;
  b: FingerprintResult;
  byArch: FingerprintComparisonRow[];
  /**
   * False when the two share no architecture, so nothing was actually compared.
   * Distinct from "not the same program", which is a comparison that came out
   * negative rather than one that never happened.
   */
  comparable: boolean;
  /** Same UUID: the same build, exactly. */
  sameBuild: boolean;
  /** Same fingerprint: the same program, modulo a rebuild. */
  sameProgram: boolean;
  /** True only when differing UUIDs *prove* a rebuild happened. */
  rebuilt: boolean;
  verdict: string;
  /** Present when a match rests on shape alone, bounding the claim. */
  caveat: string | null;
}

/** One difference between two binaries — a structural fact, or a literal string. */
export interface BinaryDifference {
  category: 'slices' | 'header' | 'flags' | 'load-commands' | 'sections' | 'symbols' | 'literals';
  arch: string | null;
  kind: string;
  detail: string;
  a: unknown;
  b: unknown;
}

/** The result of {@link diffBinaries}. */
export interface BinaryDiff {
  a: FingerprintResult;
  b: FingerprintResult;
  perArch: Array<{
    arch: string;
    differenceCount: number;
    symbols: { a: number; b: number; added: number; removed: number };
    sections: { a: number; b: number };
    literals: { a: number; b: number; added: number; removed: number };
  }>;
  /** Structural and content changes. The verdict is computed from these alone. */
  differences: BinaryDifference[];
  /** UUID and provenance-command changes — reported, never counted. */
  buildMetadata: Array<{ arch: string | null; kind: string; detail: string; name: string | null }>;
  /** Section sizes, reported because they matter and counted separately. */
  sizeChanges: Array<{ arch: string; section: string; a: number; b: number; delta: number }>;
  counts: { differences: number; buildMetadata: number; sizeChanges: number };
  sameBuild: boolean;
  sameShape: boolean;
  verdict: 'identical' | 'same program, rebuilt' | 'same structure, different symbol set' | 'different structure';
}

/** One file's row in a {@link searchSymbolsIn} result. */
export interface CorpusFile {
  path: string;
  ok: boolean;
  error: string | null;
  message?: string;
  arch: string | null;
  count: number;
  uniqueCount?: number;
  defined?: number;
  total?: number;
  note?: string | null;
  /** Names, capped by `perFile`. */
  matches: SymbolEntry[];
  matchesTruncated: boolean;
}

/** The result of {@link searchSymbolsIn}. */
export interface CorpusSearch {
  pattern: string;
  mode: 'substring' | 'regex';
  flags: string | null;
  definedOnly: boolean;
  dedupe: boolean;
  roots: string[];
  files: CorpusFile[];
  totals: {
    files: number;
    /** How many of `files` were actually read. Separate, so "N read" cannot lie. */
    looked: number;
    matchedFiles: number;
    matches: number;
    skipped: number;
    unreadable: number;
    considered: number;
  };
  /** True when the walk stopped early, so the answer covers only what was reached. */
  truncated: boolean;
  note: string | null;
}

/**
 * One load command, as a fact about the file rather than an interpretation of it.
 *
 * Recorded before any decoding, so a command this reader does not understand
 * still appears — with `name` null and its `cmd` number intact — rather than
 * being dropped. A reader that silently discarded the ones it could not decode
 * would make an unfamiliar binary look simpler than it is, which is the shape of
 * a wrong answer rather than a partial one.
 *
 * `offset` is relative to the start of the containing slice, not the file.
 */
export interface LoadCommand {
  /** The raw `LC_*` constant. */
  cmd: number;
  /** Its symbolic name, or null when this reader has no name for it. */
  name: string | null;
  cmdsize: number;
  offset: number;
}

/** A parsed `LC_SYMTAB`. */
export interface Symtab {
  symoff: number;
  nsyms: number;
  stroff: number;
  strsize: number;
}

/** One load command, as recorded before any decoding. */
export interface LoadCommand {
  cmd: number;
  name: string;
  cmdsize: number;
  /** Offset from the start of the slice, not of the file. */
  offset: number;
}

/** A parsed `LC_VERSION_MIN_IPHONEOS` or `LC_BUILD_VERSION`, as OS and SDK strings. */
export interface Platform {
  /** The raw `PLATFORM_*` constant. */
  platform: number;
  /** Its symbolic name, e.g. `ios`, `macos`. */
  name: string;
  /** `major.minor.patch`, from whichever command supplied it. */
  minos: string;
  /** `major.minor.patch`; null for a `LC_VERSION_MIN_IPHONEOS`-only header. */
  sdk: string | null;
}

/** A parsed `LC_ENCRYPTION_INFO` / `LC_ENCRYPTION_INFO_64`. */
export interface EncryptionInfo {
  cryptoff: number;
  cryptsize: number;
  /** 0 when the binary was never encrypted; 1 for an App Store build. */
  cryptid: number;
}

/** A parsed thin Mach-O header plus its load-command tables. */
export interface Thin {
  is64: boolean;
  cputype: number;
  /** The subtype from the header, byte 8. See {@link FatSlice.cpusubtype}. */
  cpusubtype: number;
  filetype: number;
  /** Computed here so every consumer names `MH_EXECUTE`/`MH_DYLIB`/`MH_BUNDLE` alike. */
  filetypeName: string;
  ncmds: number;
  sizeofcmds: number;
  /** The raw header `flags` word, byte 24. See {@link decodeHeaderFlags}. */
  flags: number;
  segments: Segment[];
  sections: Section[];
  loadCommands: LoadCommand[];
  symtab: Symtab | null;
  uuid: string | null;
  /** Null when the header carries no version/build command, as on macOS. */
  platform: Platform | null;
  /** The raw `LC_MAIN` command, or null. See {@link resolveEntryPoint}. */
  entryPoint: {
    entryoff: bigint;
    stacksize: bigint | null;
    rawHigh32: number;
    valueBasis: string;
    cmdsize: number;
  } | null;
  sourceVersion: SourceVersion | null;
  /**
   * The platform this slice was built for, or null when it declares none.
   *
   * Null is a real answer, not a gap: an `MH_OBJECT` and a pre-10.14 binary both
   * look like this, because `LC_BUILD_VERSION` did not exist before 10.14 and the
   * older `LC_VERSION_MIN_*` commands are decoded into the same shape.
   */
  buildVersion: BuildVersion | null;
  /** FairPlay state, or null. See {@link Encryption}. */
  encryption: Encryption | null;
  /** What kind of Mach-O this is. See {@link Filetype}. */
  filetype: Filetype | null;
  /** `LC_RPATH` paths, in the order the binary declares them. */
  rpaths: string[];
  /**
   * Every `dylib_command` dependency, in declaration order.
   *
   * Empty for `MH_EXECUTE` on modern macOS, which links nothing — the system
   * libraries arrived through `LC_DYLD_CHAINED_FIXUPS` and are not on disk as
   * Mach-O at all. See `README.md` §Limits.
   */
  dylibs: DylibRef[];
  /**
   * This image's own `LC_ID_DYLIB` install name, or null.
   *
   * Set on `MH_DYLIB`, `MH_BUNDLE` and `MH_DYLIB_STUB`; what clients are meant to
   * link against. `null` on an executable, which has no install name.
   */
  installName: DylibRef | null;
  /**
   * The raw `LC_FUNCTION_STARTS` command, or null. Decoded lazily by
   * `functionStartAddresses`, because a slice never asked about its function
   * starts should not pay to read them.
   */
  functionStarts: { dataoff: number; datasize: number; cmdsize: number } | null;
}

/**
 * A decoded `filetype` — what kind of Mach-O this is.
 *
 * `name` is null when the value is not one of the fourteen this reader's table
 * covers, which is how a platform adding a fifteenth shows up: as an unnamed number
 * rather than as a confident wrong name.
 */
export interface Filetype {
  /** The raw `filetype` word from the header. */
  raw: number;
  /** `MH_EXECUTE`, `MH_DYLIB`, `MH_DSYM`, … or null when unrecognised. */
  name: string | null;
  /** False only when `name` is null. */
  named: boolean;
}

/**
 * FairPlay encryption state, from `LC_ENCRYPTION_INFO` or `LC_ENCRYPTION_INFO_64`.
 *
 * The field that matters is `encrypted`, and it is `cryptid > 0` rather than "this
 * command is present": a decrypted App Store binary keeps the command with `cryptid`
 * 0. Reading presence instead of value reports a decrypted binary as still encrypted
 * and a still-encrypted one as readable, which inverts the answer.
 */
export interface Encryption {
  /** Which command it came from. */
  command: string;
  cryptoff: number;
  cryptsize: number;
  /** 0 is not encrypted or already decrypted; 1 is an App Store build; >1 is keyed. */
  cryptid: number;
  /** `cryptid > 0` — __TEXT is ciphertext. */
  encrypted: boolean;
}

/**
 * A decoded `LC_BUILD_VERSION`, or of the older `LC_VERSION_MIN_*` that replaced it.
 *
 * The platform name is `null` when `platformRaw` is not a value this reader's table
 * covers — a newer SDK adding a platform must show up as an unnamed number rather
 * than as a confident wrong name.
 */
export interface BuildVersion {
  /** Which command it came from: `LC_BUILD_VERSION`, or e.g. `LC_VERSION_MIN_IPHONEOS`. */
  command: string;
  /** The platform by name — `macos`, `ios`, `ios-simulator`, `visionos`, … or null. */
  platform: string | null;
  /**
   * The raw `platform` word.
   *
   * Null for the `LC_VERSION_MIN_*` commands, which carry no platform field — their
   * platform *is* the command. Non-null alongside a null `platform` means the word is
   * one this reader's table does not name.
   */
  platformRaw: number | null;
  minos: PackedVersion;
  sdk: PackedVersion;
  /**
   * Tool records the command declares past the 24 bytes read here.
   *
   * Non-zero means there is more in the command than this reports. It is surfaced
   * rather than ignored so that a caller knows a field is absent by choice.
   */
  ntools: number;
}

/**
 * A version in the linker's packed `X << 16 | Y << 8 | Z` form.
 *
 * `raw` is the file's own word and `text` the same value read out; both are reported
 * so a value can be compared against another reader's without either side converting.
 */
export interface PackedVersion {
  raw: number;
  x: number;
  y: number;
  z: number;
  /** `X.Y.Z`. */
  text: string;
}

/**
 * One decoded `struct dylib_command`.
 *
 * The three version fields are the linker's **packed** form, `X << 16 | Y << 8 |
 * Z`, not separate numbers — `0x05000001` is compatibility version 5.0.1. They
 * are reported packed because that is what the file holds and what Go's
 * `debug/macho` reports, so a value cross-checked against another reader compares
 * equal without a conversion either side has to make.
 */
export interface DylibRef {
  /** The recorded name: an absolute path, or an `@rpath`/`@loader_path` token. */
  name: string;
  /** The raw `cmd` word. */
  cmd: number;
  /** Its name in `<mach-o/loader.h>`, e.g. `LC_LOAD_WEAK_DYLIB`. */
  cmdName: string;
  /**
   * How the loader treats the command, and therefore what a *missing* library
   * means. `'load'` is a hard dependency; `'weak'` tolerates absence; `'lazy'`
   * defers the load; `'reexport'` also republishes that image's symbols here;
   * `'upward'` is satisfied by an older image already in the stack.
   *
   * Absent on {@link SliceShape.installName}, which is not a dependency.
   */
  linkage?: 'load' | 'weak' | 'lazy' | 'reexport' | 'upward';
  timestamp: number;
  currentVersion: number;
  compatVersion: number;
  /** The `LC_UUID` of this slice, lowercased, or null when it carries none. */
  uuid: string | null;
  /** Null when the header carries no version/build command, as on macOS. */
  platform: Platform | null;
  /** Null when the header carries no encryption command, as on a simulator build. */
  encryption: EncryptionInfo | null;
}

/** One symbol-table entry. */
export interface SymbolEntry {
  name: string;
  addr: bigint;
  /** True for `N_SECT` symbols — defined here, as opposed to imported. */
  defined: boolean;
}

/** The result of reading a symbol table. Every key is always present. */
export interface Symbols {
  names: string[];
  entries: SymbolEntry[];
  /** How many entries are defined in this slice. */
  defined: number;
  total: number;
  /** Why the list is empty, when it is. `null` when it is not. */
  note: string | null;
}

/** Parse a fat header into its slices, or `null` when this is not a fat binary. */
export declare function parseFat(f: Opener): FatSlice[] | null;

/** Parse the load commands of the thin Mach-O at `base`. */
export declare function parseThin(f: Opener, base?: number): Thin | null;

/** Header `flags` bits, as `[bit, name]`, transcribed from `<mach-o/loader.h>`. */
export declare const MH_FLAGS: Array<[number, string]>;

/** Section types, keyed by the low 8 bits of a section's `flags`. */
export declare const SECTION_TYPES: Record<number, string>;

/** Section attribute bits, as `[bit, name]`. */
export declare const SECTION_ATTRIBUTES: Array<[number, string]>;

/** `SECTION_TYPE` — the low byte of a section's `flags`. */
export declare const SECTION_TYPE_MASK: number;

/** Decode a header `flags` word into names, plus any bits it cannot name. */
export declare function decodeHeaderFlags(flags: number): HeaderFlags;

/**
 * Split a section's `flags` into its type and its attributes.
 *
 * The two are disjoint — type is the low 8 bits, attributes the top 24 — and
 * answer different questions. `attributesUnknown` is bounded to the attribute
 * region, so the type byte is never reported as an unknown attribute.
 */
export declare function decodeSectionFlags(flags: number): DecodedSectionFlags;

/** Decode an `LC_SOURCE_VERSION` word, packed `a24.b10.c10.d10.e10`. */
export declare function decodeSourceVersion(v: bigint): SourceVersion;

/**
 * An `LC_MAIN` entry point, with no address derived from it.
 *
 * `entryoff` is the raw file (`__TEXT`) offset the command declares. `vaddr` is
 * always `null`: an address is one `a2o` call away, and computing it here as well
 * would give the same fact two answers that could disagree.
 */
export declare function resolveEntryPoint(thin: Thin): EntryPoint | null;

/**
 * Is this file internally consistent? Every structural check, in one call.
 *
 * `verdict` is a label for a person; `clean` and `strictClean` are the gate.
 * Branch on the booleans — mapping `verdict` straight onto an exit status fails a
 * build over a binary that `clean: true` says is fine.
 */
export declare function audit(
  path: string,
  opts?: { arch?: string | null; strict?: boolean },
): AuditResult;

/**
 * What is this binary, ignoring everything a rebuild moves?
 *
 * Three answers, kept apart: `uuid` (same build), `fingerprint` (same program),
 * `structure` (same shape — and all a stripped binary can offer, which `tier`
 * discloses).
 */
export declare function fingerprint(
  path: string,
  opts?: { arch?: string | null },
): FingerprintResult;

/** Compare two binaries, reporting which of the three questions the answer settles. */
export declare function compareFingerprints(a: string, b: string): FingerprintComparison;

/**
 * What changed between two binaries, structurally.
 *
 * Addresses, sizes, offsets and the UUID are not differences — a rebuilt binary
 * should not read as a different one. Build-metadata changes are reported in
 * `buildMetadata` and excluded from the verdict.
 */
export declare function diffBinaries(
  a: string,
  b: string,
  opts?: { arch?: string | null; maxNames?: number },
): BinaryDiff;

/** One assertion and whether it held. */
export interface AssertionResult {
  kind: 'has-symbol' | 'no-symbol' | 'has-string' | 'no-string';
  value: string;
  pass: boolean;
  /** What was found, in the caller's own terms. */
  detail: string;
}

/**
 * The result of evaluating a policy of must-be-here and must-not-be claims.
 *
 * `passed` is the gate: true only when every assertion held. A failed assertion is
 * an answer, not an error, so nothing here throws for a claim that did not hold.
 */
export interface AssertResult {
  path: string;
  arch: string | null;
  passed: boolean;
  count: number;
  failed: number;
  assertions: AssertionResult[];
}

/**
 * Evaluate a policy of "this must be here" and "this must not be" claims.
 *
 * `has-symbol`/`no-symbol` match the whole symbol name; `has-string`/`no-string`
 * match a substring of any NUL-terminated string. Both string reads are the ones
 * `findStrings` performs, over the same sections.
 */
export declare function assertBinary(
  path: string,
  assertions: Array<{ kind: 'has-symbol' | 'no-symbol' | 'has-string' | 'no-string'; value: string }>,
  opts?: { arch?: string },
): AssertResult;

/**
 * Search the symbol tables of many binaries in one call, through the same envelope
 * as a single-binary search.
 *
 * Non-Mach-O files are counted in `totals.skipped`, not reported as errors; a path
 * that does not exist is reported per file with reason code `io`.
 */
export declare function searchSymbolsIn(
  roots: string[] | string,
  pattern: string,
  opts?: {
    arch?: string;
    mode?: 'substring' | 'regex';
    flags?: string;
    definedOnly?: boolean;
    dedupe?: boolean;
    max?: number;
    perFile?: number;
    matchedOnly?: boolean;
    maxFiles?: number;
    maxDepth?: number;
  },
): CorpusSearch;

/** Shannon entropy of a buffer, in bits per byte (0..8). */
export declare function shannonEntropy(
  f: Opener,
  offset: number,
  length: number,
  maxBytes?: number,
): number;

/**
 * Structural problems in one slice: unknown flag bits, a truncated load-command
 * list, sections or tables reaching past the slice, overlapping symbol and string
 * tables, an over-flat string table.
 *
 * Returns `[]` for a healthy binary. Parsing stays permissive: these are reported
 * *alongside* a successful parse, never instead of one.
 */
export declare function detectAbnormalities(
  f: Opener,
  thin: Thin,
  opts?: { sliceOffset?: number; sliceSize?: number | null },
): Abnormality[];

/**
 * Structural problems with the *fat table* — overlapping slices, a slice past the
 * end of the file, a misaligned slice offset.
 *
 * Separate from {@link detectAbnormalities} because none of those checks can see a
 * slice that overlaps its neighbour: each slice is internally consistent, and the
 * lie is between them. Returns `[]` for a thin binary, which has no fat table to be
 * inconsistent with.
 */
export declare function detectContainerAbnormalities(f: Opener): Abnormality[];

/** A short, stable, order-independent digest of a list of strings. */
export declare function digestOf(items: string[], length?: number): string;

/**
 * A structural digest of one slice, excluding everything a rebuild moves: no
 * address, no size, no offset, and none of the provenance load commands
 * (`LC_UUID`, `LC_CODE_SIGNATURE`, `LC_DYLIB_CODE_SIGN_DRS`, `LC_SOURCE_VERSION`).
 */
export declare function sliceShape(p: {
  arch: string;
  bits: number;
  filetype: number;
  sections: Array<{ segname: string; sectname: string }>;
  loadCommands: LoadCommand[];
  definedSymbols: Array<{ name: string }>;
}): {
  structure: string;
  symbols: string | null;
  fingerprint: string;
  tier: FingerprintTier;
  nsyms: number;
};

/** A digest for a whole file, combining per-slice digests. */
export declare function fileShape(slices: Array<{ arch: string; fingerprint: string }>): string;

/** Every slice of a binary, fat or thin. */
export declare function slicesOf(f: Opener): Slice[];

/** The `__TEXT` section of a parsed slice, which is where literals live. */
export declare function textSection(thin: Thin): Section | null;

/** True when a section's attributes mark it as containing instructions. */
export declare function isCodeSection(sec: Section): boolean;

/**
 * The sections of a slice that hold code.
 *
 * `fallback` is true when the slice marked no section as instructions, in which
 * case every non-empty section is returned — an unusual input where reporting
 * zero call sites would be worse than an untyped scan.
 */
export declare function codeSections(thin: Thin): {
  sections: Section[];
  fallback: boolean;
};

/** Read every symbol in a slice, defined and imported, counted apart. */
export declare function readSymbols(f: Opener, base: number, thin: Thin): Symbols;

/** The slice with the most symbols — the one most worth probing. */
export declare function richestSlice(f: Opener): (Slice & {
  arch: string;
  thin: Thin;
  names: string[];
  nsyms: number;
  ndefined: number;
  stripped: boolean | string;
  symNote: string | null;
}) | null;

/**
 * The byte offset of the slice a tool should read.
 *
 * `prefer` is a preference, not a requirement: a named architecture that is
 * absent falls back to the richest slice rather than returning null.
 */
export declare function preferredSlice(
  f: Opener,
  prefer?: string,
): { offset: number; arch: string; nsyms: number; thin: Thin; size: number } | null;

/**
 * Map a file offset to a vaddr within a parsed slice, or null if unmapped.
 *
 * Zero-fill sections are skipped: they have no bytes in the file, so an offset
 * inside one belongs to whatever actually occupies that range.
 */
export declare function toVaddr(
  thin: Thin,
  fileOff: number,
): { vaddr: bigint; section: string } | null;

/**
 * Map a vaddr to a slice-relative file offset within a parsed slice, or null.
 *
 * `zerofill: true` means the address is mapped but has no byte in the file —
 * `__bss`, `__PAGEZERO`, or a segment tail past `filesize`. That is a different
 * answer from `null`, which means the address is not in this slice at all.
 */
export declare function toFileOffset(
  thin: Thin,
  vaddr: Vaddr,
): { offset: number | null; zerofill: boolean; section: string; segname: string } | null;

/** True when a section occupies bytes in the file rather than being zero-fill. */
export declare function isBackedByFile(thin: Thin, sec: Section): boolean;

/** The section containing a slice-relative file offset, or null. */
export declare function sectionOf(thin: Thin, fileOff: number): Section | null;

/** True when `vaddr` falls inside anything this slice maps. */
export declare function coversAddress(thin: Thin, vaddr: Vaddr): boolean;

/** Find a byte string inside a section, stopping early per needle. */
export declare function findInSection(
  f: Opener,
  sec: Section,
  needles: string[],
  opts?: { perNeedle?: number; chunk?: number; overlap?: number; sliceBase?: number },
): { hits: Map<string, Array<{ off: number; vaddr: bigint; section: string; ctx: string }>>; scanned: number; available: boolean };

/* ------------------------------------------------------------------ *
 * the supported API
 * ------------------------------------------------------------------ */

/** Open a binary, hand it to `fn`, close it afterwards. */
export declare function withFile<T>(path: string, fn: (f: Opener) => T): T;

/**
 * What is in this file: every slice, with architecture, extent and symbol counts.
 *
 * The three lists the reader had already parsed and nothing surfaced —
 * `segments`, `sections` and `loadCommands` — are always present rather than
 * behind a flag, because the data is already read and asking costs nothing.
 * `codeSections` is a count of how many are code; the `sections` list is the
 * answer to "what is in this file", which is a different question.
 *
 * A slice whose header does not parse is still reported, with `readable: false`,
 * a `note` saying why, and the three lists empty. It is not omitted, so the
 * slice count is a fact about the fat header rather than about this reader's
 * luck.
 */
export declare function describe(path: string): {
  path: string;
  size: number;
  /** True when the file holds more than one slice. */
  fat: boolean;
  slices: Array<{
    arch: string;
    offset: number;
    size: number;
    thin: boolean;
    readable: boolean;
    /** Absent on a slice that did not parse, which is why it is not optional here. */
    bits: 64 | 32 | undefined;
    /**
     * The iOS-facing header facts. A Mach-O from an iPhone and one from a Mac
     * are byte-compatible everywhere the reader used to look, so without these
     * nothing here could tell you which you were holding.
     */
    /** The raw `MH_*` filetype constant. */
    filetype: number | null;
    /** Its symbolic name, or null when the slice did not parse. */
    filetypeName: string | null;
    /** The raw `PLATFORM_*` constant, or null when the header carries no platform command. */
    platform: number | null;
    platformName: string | null;
    /** Minimum OS version as `major.minor.patch`, or null with no platform command. */
    minos: string | null;
    /** SDK version as `major.minor.patch`, or null with no platform command. */
    sdk: string | null;
    cpusubtype: number | null;
    /**
     * `LC_ENCRYPTION_INFO`'s `cryptid`: 0 on a binary that was never encrypted,
     * and null when the file carries no such command at all. Those are different
     * facts — a simulator build has no encryption command, an App Store build
     * has one saying 1 — so they stay distinct rather than collapsing.
     */
    cryptid: number | null;
    /** `cryptid !== 0`, or null when there is no `cryptid` to interpret. */
    encrypted: boolean | null;
    nsyms: number;
    defined: number;
    note: string | null;
    textAddr: bigint | null;
    textSize: number;
    codeSections: number;
    /** The slice's segments, as `{ segname, vmaddr, vmsize, fileoff, filesize }`. */
    segments: Segment[];
    sections: Section[];
    loadCommands: LoadCommand[];
    /** Lowercase RFC-4122, or null when the slice carries no `LC_UUID`. */
    uuid: string | null;
    /** The raw header `flags` word. */
    flags: number;
    /** Its decoded names, e.g. `MH_PIE`. */
    flagsNamed: string[];
    /** Flag bits with no name in `<mach-o/loader.h>`. Zero on a known binary. */
    flagsUnknown: number;
    entryPoint: EntryPoint | null;
    /**
     * The platform this slice was built for, or null.
     *
     * See {@link BuildVersion}. `null` on an object file and on a pre-10.14 binary.
     */
    buildVersion: BuildVersion | null;
    /** FairPlay state, or null when the binary declares no encryption command. */
    encryption: Encryption | null;
    /** What kind of Mach-O this is. See {@link Filetype}. */
    filetype: Filetype | null;
    /** `LC_RPATH` paths, in declaration order. */
    rpaths: string[];
    /**
     * What this slice must be able to find to load, in declaration order — the
     * answer `otool -L` gives. Each entry keeps its own `linkage`, because the
     * five `dylib_command`s differ in what an absent library means.
     */
    dylibs: DylibRef[];
    /** This slice's own `LC_ID_DYLIB` install name, or null. */
    installName: DylibRef | null;
    sourceVersion: SourceVersion | null;
    /** Structural problems. Empty on a healthy binary. */
    abnormalities: Abnormality[];
    segments: Segment[];
    sections: Section[];
    loadCommands: LoadCommand[];
    /** The slice's `LC_UUID`, lowercased, or null when it carries none. */
    uuid: string | null;
  }>;
  /**
   * Problems with the fat table itself — overlapping slices, a slice past the end
   * of the file, a misaligned offset.
   *
   * Reported here as well as by `audit` because no per-slice check can see these:
   * two slices claiming the same bytes are each internally consistent. Empty for a
   * thin binary, which has no fat table to be inconsistent with.
   */
  containerAbnormalities: Abnormality[];
};

/**
 * The symbol inventory {@link overview} reports, deduplicated by name and
 * sorted by address. `addr` is a BigInt: it is a virtual address, and it does not
 * survive a JSON number.
 */
export interface OverviewSymbols {
  /** The slice this list was read from, named because a universal binary has several. */
  arch: string | null;
  /** Distinct defined names in the slice — the length of the full list, not of `symbols`. */
  count: number;
  /** Table entries with a non-zero address. */
  defined: number;
  /** Table entries that are imports. Counted rather than dropped silently. */
  imports: number;
  /** True when `max` dropped rows. A shortened list is never presented as complete. */
  truncated: boolean;
  /** The cap that was applied. `0` means unlimited. */
  max: number;
  symbols: Array<{ name: string; addr: bigint }>;
  /** Why the list is empty or short, or null when there is nothing to say. */
  note: string | null;
}

/** The string inventory {@link overview} reports. `vaddr` is a BigInt, as above. */
export interface OverviewStrings {
  arch: string | null;
  /** Shortest string reported. */
  min: number;
  /** Strings found, which is more than `strings.length` when `truncated`. */
  count: number;
  /** Bytes of C-string section actually read. Zero when the slice has none. */
  scanned: number;
  truncated: boolean;
  max: number;
  /** The C-string section names this reader looks for. */
  sections: string[];
  strings: Array<{
    off: number;
    slice: string;
    vaddr: bigint;
    section: string;
    length: number;
    text: string;
  }>;
  /**
   * Why the list is empty or short, or null.
   *
   * Load-bearing: zero strings because the slice has no `__cstring` section is a
   * fact about the file, and zero strings because a reader looked and found none
   * is a different fact. Both serialise as `[]`, so this is what tells them
   * apart.
   */
  note: string | null;
}

/**
 * Everything this package can tell you about a binary, in one call: the whole of
 * {@link describe}'s answer plus two optional inventories.
 *
 * ## Why the inventories are opt-in
 *
 * They scale with the file while the structure does not — on a 14.5 MB Go binary
 * the structure is 9.2 KB of JSON and the symbol table is the difference between
 * that and 422 KB. Including them by default would make the answer 99% symbol
 * table on the largest binaries, which is the opposite of an overview.
 *
 * ## `notRead` is not decoration
 *
 * The list of what this reader does not implement travels in every result. A JSON
 * object that looks exhaustive and is silent about what it skipped cannot be
 * distinguished from one that genuinely has nothing to report, and that
 * distinction is the difference between a fact and a gap.
 */
export declare function overview(
  path: string,
  opts?: {
    /** Narrow a universal binary to one slice. A preference: an absent architecture falls through to all. */
    arch?: string | null;
    /** Include the symbol table. */
    symbols?: boolean;
    /** Include the C-string section contents. */
    strings?: boolean;
    /** Cap on each inventory. Default 4000; `0` is unlimited. */
    max?: number;
    /** Shortest string to report. Default 4. */
    min?: number;
  },
): {
  path: string;
  size: number;
  fat: boolean;
  /** Exactly `describe`'s slice objects, so a field means the same thing in both. */
  slices: ReturnType<typeof describe>['slices'];
  containerAbnormalities: Abnormality[];
  /**
   * What this package does not read, on every call.
   *
   * Kept in step with `README.md`'s "What it will not do" by hand and asserted
   * against it by the suite — a gap list that drifts from the refusal list is
   * worse than none, because it is one that is confidently wrong.
   */
  notRead: string[];
  /** Present only when `opts.symbols` was set. */
  symbols?: OverviewSymbols;
  /** Present only when `opts.strings` was set. */
  strings?: OverviewStrings;
  /** Present when `--arch` narrowed or failed to narrow the slice list. */
  notes?: string[];
};

/**
 * One address/offset mapping. Three outcomes, kept apart on purpose.
 *
 * `query` and `vaddr` are hex strings. A 64-bit vaddr does not survive a `Number`
 * and a BigInt does not survive `JSON.stringify`, so a numeric field here would
 * either throw or lose precision silently. Offsets stay numeric because a file
 * position is far below 2^53 in practice and is arithmetic rather than identity.
 */
export interface OffsetRow {
  arch: string | null;
  /** What was asked: a vaddr for `a2o`, a file offset for `o2a`. */
  query: string;
  /** The address this row maps to, as `0x…`. Null only when unmapped. */
  vaddr: string | null;
  /** Slice-relative, matching the section table. Null when zero-fill or unmapped. */
  offset: number | null;
  /** `offset` plus the slice's position in the file. Null when there is no byte. */
  absoluteOffset: number | null;
  /** `__TEXT,__text`, or `__DATA (segment)` for a range no section covers. */
  section: string | null;
  /** Mapped in memory but absent from the file: `__bss`, `__PAGEZERO`. */
  zerofill: boolean;
  /** False when no slice maps the address at all. */
  mapped: boolean;
  /** True when several slices map it — a universal binary maps 0x100000000 in each. */
  ambiguous?: boolean;
  /** Per-slice detail, present when `ambiguous` or `mapped` is false. */
  slices?: OffsetRow[];
  note: string | null;
}

/**
 * Virtual address to file offset.
 *
 * Returns one row when exactly one slice maps the address. On a universal binary
 * without `arch`, every slice maps `0x100000000` by construction, so the row
 * comes back `ambiguous` with `slices` filled in rather than guessing which
 * binary was meant.
 */
export declare function addressToOffset(
  path: string,
  vaddr: Vaddr,
  opts?: { arch?: string },
): OffsetRow;

/**
 * File offset to virtual address, for one or more offsets.
 *
 * Offsets are absolute positions in the file; each slice's row also carries its
 * own slice-relative offset. Every slice is examined, because the same offset
 * means a different address in each.
 */
export declare function offsetToAddress(
  path: string,
  offsets: Vaddr | Vaddr[],
  opts?: { arch?: string },
): {
  path: string;
  queries: Array<{
    /** The absolute file offset asked about, as `0x…`. */
    query: string;
    basis: 'absolute';
    slices: OffsetRow[];
    /** The single mapping as `0x…`, or null when none or more than one. */
    vaddr: string | null;
    ambiguous: boolean;
  }>;
  slices: Array<{ arch: string; offset: number }>;
};

/** One row of a `dump`, normally sixteen bytes. Addresses are hex, offsets numeric. */
export interface DumpLine {
  /** Slice-relative file offset of the row's first byte. */
  offset: number;
  /** The same position in the whole file, with the slice's offset added. */
  absoluteOffset: number;
  /** `0x…`, the address of the row's first byte. */
  vaddr: string;
  /** The bytes as space-separated hex pairs — sixteen pairs, or fewer on the last row. */
  hex: string;
  /** The same bytes as printable ASCII, with everything else as `.`. */
  ascii: string;
}

/**
 * The bytes at a virtual address, resolved through the section that maps it.
 *
 * `found` is false in the two cases where an address is a real answer but has
 * no byte: `zerofill` (mapped, absent from the file) and `mapped: false` (in no
 * slice). `truncated` means the request outran the section's own end.
 */
export interface DumpResult {
  path: string;
  arch: string | null;
  mode: 'address';
  /** The address asked about, as `0x…`. */
  vaddr: string;
  /** `__TEXT,__text`, or `__DATA (segment)` for a range no section covers. */
  section: string | null;
  /** Slice-relative offset of the first byte. Null when there is no byte. */
  offset: number | null;
  /** The first byte's position in the whole file. Null when there is no byte. */
  absoluteOffset: number | null;
  mapped: boolean;
  zerofill: boolean;
  found: boolean;
  /** The `length` asked for, after the 1 MiB cap. */
  requestedBytes: number;
  /** How many bytes were actually read. */
  bytes: number;
  /** True when the section (or the slice) ended before `requestedBytes` did. */
  truncated: boolean;
  lines: DumpLine[];
}

/**
 * The bytes at an address, bounded by the section that maps it.
 *
 * This is `addressToOffset` followed by a read. The address resolves to a
 * section, the dump starts there and stops at that section's own end so it
 * never blends `__cstring` into `__const`, and the slice's extent is a second
 * bound because the bytes after a slice belong to the next architecture.
 */
export declare function dumpBytes(
  path: string,
  vaddr: Vaddr,
  opts?: { arch?: string; length?: number },
): DumpResult;

/** One function start: an address, its synthetic label, and the symbol on it if any. */
export interface FunctionStart {
  index: number;
  /** `0x…`, the address the linker recorded. */
  address: string;
  /** `sub_<hex>` — a name for the address, not a claim about what the function does. */
  label: string;
  /** The defined symbol sitting exactly on this start, or null. */
  symbol?: string | null;
}

/**
 * The function start addresses a slice declares, with optional symbol names.
 *
 * `present` is false when the file carries no `LC_FUNCTION_STARTS` at all, which is
 * an answer rather than an empty list. `blobTruncated` means the blob ends
 * mid-value and the last delta was dropped. `capped` means `max` cut the list
 * short; `count` stays exact either way. `named` is null unless `symbols` was
 * requested.
 */
export interface FunctionStartsResult {
  path: string;
  arch: string | null;
  present: boolean;
  /** The image base the deltas are relative to, as `0x…`. */
  base: string | null;
  /** How many starts were decoded, before any `max` cap. */
  count: number;
  blobTruncated: boolean;
  capped: boolean;
  functions: FunctionStart[];
  /** How many starts carry a defined symbol; null when `symbols` was not requested. */
  named: number | null;
}

/**
 * The function entry addresses the linker recorded, read from `LC_FUNCTION_STARTS`.
 *
 * This is the only such list a stripped binary carries: the symbol table is gone,
 * but the command survives because the unwinder needs it at runtime.
 */
export declare function listFunctionStarts(
  path: string,
  opts?: { arch?: string; symbols?: boolean; max?: number },
): FunctionStartsResult;

/**
 * Search a symbol table by substring or regex, with one coherent set of rules.
 *
 * This replaced two narrower functions: `grepSymbols` (regex, defined-only, one
 * row per entry) and `findSymbols` (substring, imports included, deduplicated by
 * name). Both were removed rather than aliased — the merged rules above are the
 * only symbol-search contract, which is the point of the merge.
 */
export declare function searchSymbols(
  path: string,
  pattern: string,
  opts?: {
    arch?: string;
    mode?: 'substring' | 'regex';
    flags?: string;
    definedOnly?: boolean;
    dedupe?: boolean;
    max?: number;
  },
): {
  arch: string;
  pattern: string;
  mode: 'substring' | 'regex';
  /** Regex flags actually applied; `null` in substring mode, where none are. */
  flags: string | null;
  matches: SymbolEntry[];
  /** Matches before deduplication and the row cap. */
  count: number;
  /** Distinct names among the matches. */
  uniqueCount: number;
  /** True when `max` dropped rows. */
  truncated: boolean;
  deduped: boolean;
  definedOnly: boolean;
  defined: number;
  total: number;
  note: string | null;
};

/**
 * Which function contains a virtual address.
 *
 * Only defined, address-bearing symbols are considered. `function` is null with
 * a `note` when nothing resolves — a negative answer, not an error.
 *
 * An address the slice does not map resolves to null, with a note saying so,
 * rather than to the last symbol below it. A symbol's own entry point always
 * resolves even where it sits one past the last mapped byte, which is where a
 * BSS symbol can land.
 *
 * `aliases` lists the other names starting at the same address, or is null when
 * the answer is the only one. `nlist_64` has no size field, so a zero-size
 * linker region marker is indistinguishable from a real function here; where
 * `aliases` is set, treat `size` as a bound rather than a measurement.
 */
export declare function lookupAddress(
  path: string,
  vaddr: Vaddr,
  opts?: { arch?: string },
): {
  arch: string;
  vaddr: bigint;
  function: string | null;
  start: bigint | null;
  next: bigint | null;
  offset: bigint | null;
  size: bigint | null;
  aliases: string[] | null;
  note: string | null;
};

/** The direct-call encoding for an architecture, or null if unknown. */
export declare function callEncoding(arch: string): 'x86 rel32' | 'arm64 BL' | null;

/** One direct call or jump that resolves to a target address. */
export interface CallSite {
  addr: bigint;
  kind: 'call' | 'jmp' | 'BL';
  arch: string;
  /** The section the instruction was found in. */
  section: string;
}

/** Per-slice accounting for a call scan. */
export interface CallSliceReport {
  arch: string;
  encoding: 'x86 rel32' | 'arm64 BL';
  /** True when only instruction-flagged sections were scanned. */
  typed: boolean;
  /** True when the slice flagged no section as instructions at all. */
  untypedFallback: boolean;
  sections: Array<{ name: string; addr: bigint; size: number }>;
  scanned: number;
  skipped: string | null;
}

/**
 * Direct `call`/`jmp` sites resolving to `target`, across every slice.
 *
 * Typed by default: only sections whose attributes mark them as instructions
 * are scanned. `includeData` widens to every non-empty section. Either way,
 * indirect calls are invisible — they do not encode their target.
 */
export declare function findCalls(
  path: string,
  target: Vaddr,
  opts?: { arch?: string; includeData?: boolean; max?: number },
): {
  target: bigint;
  hits: CallSite[];
  count: number;
  truncated: boolean;
  scanned: number;
  slices: CallSliceReport[];
  /** Architectures whose call encoding is not implemented. */
  unsupported: string[];
  /** Architectures skipped because their code is ciphertext. */
  encryptedSlices: string[];
  /**
   * True when every slice that could have held an answer was encrypted, so a
   * zero count is "could not look" rather than "found nothing". The two must not
   * share an exit code — see the note on `REASON_CODES`.
   */
  unreadable: boolean;
  typed: boolean;
};

/**
 * The distinct addresses a binary calls or jumps to directly.
 *
 * The inversion of `findCalls`, and the only way to tell a working scanner from
 * a dead one: both produce an empty caller list for one address, but only one
 * produces an empty target list for a whole binary.
 */
export declare function listCallTargets(
  path: string,
  opts?: { arch?: string; includeData?: boolean; minSites?: number },
): {
  targets: Array<{ dest: bigint; sites: number }>;
  total: number;
  scanned: number;
  slices: Array<{
    arch: string;
    encoding: 'x86 rel32' | 'arm64 BL';
    typed: boolean;
    untypedFallback: boolean;
    scanned: number;
  }>;
  unsupported: string[];
  typed: boolean;
};

/** Printable context around a file offset. */
export interface Context {
  pre: string;
  /** The file offset `pre` starts at. */
  preFrom: number;
  hit: string;
}

/** One string read out of a C-string section. */
export interface StringHit {
  /** Absolute file offset. */
  off: number;
  slice: string;
  vaddr: bigint | null;
  /** `"<segname>,<sectname>"`, or null where the section could not be named. */
  section: string | null;
  /** Byte length, excluding the terminating NUL. */
  length: number;
  text: string;
}

/**
 * List the NUL-terminated strings a binary already contains.
 *
 * Reads only the C-string sections: `__cstring`, `__objc_methname`,
 * `__swift5_reflstr` and `__objc_classname`. `__cfstring` is deliberately
 * excluded — those are 32-byte structures rather than text, so including it
 * would report addresses as if they were strings.
 *
 * A Go binary can legitimately return zero hits: Go keeps its strings
 * length-prefixed in `__gopclntab` rather than NUL-terminated, so an empty result
 * is a fact about the format rather than a failure to read.
 *
 * `min` is the shortest string reported. `max: 0` means no cap.
 */
export declare function findStrings(
  path: string,
  opts?: {
    /** Restrict to one architecture. A preference, not a filter. */
    arch?: string;
    min?: number;
    /** Cap on returned strings; 0 for no cap. */
    max?: number;
    /** Keep only strings this returns true for. */
    filter?: ((text: string) => boolean) | null;
  },
): {
  /** The architecture asked for, or null when none was. */
  arch: string | null;
  /**
   * `arch` when a slice satisfied it, else null — so a caller can tell "you got
   * the architecture you asked for" from "you got one anyway, and it was not this
   * one" without re-deriving it. Same pair, same meaning as `findLiteral`.
   */
  archHonoured: string | null;
  /** Ground truth: the architectures that actually answered. */
  archRead: string[];
  min: number;
  count: number;
  truncated: boolean;
  strings: StringHit[];
  /** Bytes examined. */
  scanned: number;
  slices: Array<{
    arch: string; offset: number; size: number; scanned: number; strings: number;
  }>;
  /** The C-string sections found, as `"<segname>,<sectname>"`. */
  sections: string[];
  /**
   * String sections whose bytes were ciphertext on this binary, as
   * `"<segname>,<sectname>"`.
   *
   * Stated per *section*, not as a boolean, because "the binary is encrypted"
   * and "these particular strings were unreadable" are different claims — and
   * only the second explains a zero. `--strings` on an encrypted App Store
   * binary must not read as "this binary has no strings", which is exactly what a
   * bare zero would say.
   */
  encryptedSections: string[];
};

/**
 * Find a byte literal.
 *
 * The whole file by default; `textOnly` restricts to `__TEXT`, which is much
 * cheaper when you already know it is there.
 */
export declare function findLiteral(
  path: string,
  literal: string | Buffer,
  opts?: { arch?: string; textOnly?: boolean; max?: number },
): {
  literal: string;
  hex: string;
  hits: Array<{
    off: number;
    slice: string;
    inText: boolean;
    vaddr: bigint | null;
    section: string | null;
    context: Context;
  }>;
  count: number;
  truncated: boolean;
  scanned: number;
  slices: Array<{
    arch: string; offset: number; size: number;
    from: number; to: number; hits: number;
    /** True when this slice carries ciphertext, null when it carries no encryption command. */
    encrypted: boolean | null;
  }>;
  textOnly: boolean;
  /**
   * Architectures carrying a non-zero `cryptid` — an App Store build's encrypted
   * `__TEXT`. A miss over these is not evidence the literal is absent.
   */
  encryptedSlices: string[];
  /**
   * The subset of `encryptedSlices` whose ciphertext actually overlaps the range
   * searched. Kept separate because "this slice is encrypted" and "the bytes I
   * read were ciphertext" are different facts, and only the second qualifies a
   * zero result.
   */
  searchedCiphertext: string[];
};

/**
 * Map a literal to its addresses, then find what points at those addresses.
 *
 * The literal search is per-slice; the pointer search is whole-file, so a
 * pointer can be reported in a slice other than the one whose literal was mapped.
 * `offsets` overrides the literal search, for magics assembled at runtime.
 */
export declare function mapLiteral(
  path: string,
  literal: string,
  opts?: { arch?: string; offsets?: number[] | null; maxPointers?: number },
): {
  literal: string;
  hex: string;
  arch: string;
  sliceOffset: number;
  /** True when `offsets` was supplied rather than searching for the literal. */
  explicit: boolean;
  locations: Array<{
    off: number;
    vaddr: bigint;
    section: string | null;
    context: Context;
    fileExtent: { offset: number; size: number } | null;
    pointers: Array<{
      off: number;
      slice: string | null;
      vaddr: bigint | null;
      section: string | null;
    }> | null;
    pointerCount: number;
    pointersTruncated: boolean;
  }>;
  unmapped: Array<{ off: number }>;
  slices: Array<{
    arch: string; offset: number; size: number; inText: number; nsyms: number;
  }>;
};

/**
 * NUL-terminated strings in the C-string sections, with where each one loads.
 *
 * `arch` is what was asked for, `archHonoured` is that value when a slice
 * satisfied it and `null` when none did, and `archRead` is the ground truth of
 * what actually answered — the same three fields `findLiteral` returns, because
 * an absent architecture is a preference rather than a filter and a search that
 * reads a slice the caller did not ask for has to say so.
 */
export declare function findStrings(
  path: string,
  opts?: {
    arch?: string;
    min?: number;
    max?: number;
    filter?: string | null;
  },
): {
  arch: string | null;
  min: number;
  count: number;
  truncated: boolean;
  strings: Array<{
    off: number;
    slice: string;
    vaddr: bigint;
    section: string;
    length: number;
    text: string;
  }>;
  scanned: number;
  slices: Array<{
    arch: string;
    offset: number;
    size: number;
    sections: string[];
    strings: number;
    scanned: number;
  }>;
  sections: string[];
  archHonoured: string | null;
  archRead: string[];
};

/**
 * Find every occurrence of `needle` in the absolute file range `[from, to)`.
 *
 * Chunked with a carry window, so a match straddling a chunk boundary is not
 * dropped.
 */
export declare function searchRange(f: Opener, needle: Buffer, from: number, to: number): number[];

/** Printable context around an absolute file offset. */
export declare function contextAround(f: Opener, off: number, preLen?: number, hitLen?: number): Context;

/* ================================================================== *
 * Instruction decoding
 *
 * Boundaries and direct branch edges. Not mnemonics and not operands — see
 * the note on each declaration below, because "disassemble" here means narrower
 * than the word usually does.
 * ================================================================== */

/** One decoded instruction, as a sweep reports it. */
export interface Instruction {
  /** Virtual address of the first byte. */
  addr: Vaddr;
  /** The instruction's bytes. Shorter than `length` when the record was clipped
   *  at the end of the requested range. */
  bytes: Buffer;
  /** Full decoded length, even where `bytes` is clipped. */
  length: number;
  /**
   * Branch family — `CALL`, `JMP`, `Jcc`, `LOOP`, `JRCXZ` on x86_64; `BL`,
   * `B`, `B.cond`, `CBZ`, `CBNZ`, `TBZ`, `TBNZ`, `ADR`, `ADRP` on arm64 — or
   * `null` for an instruction that does not branch.
   */
  kind: string | null;
  /** Resolved direct branch target, or `null`. `ADR` and `ADRP` are reported as
   *  branches but are not PC-relative, so a `BL` from the same address does not
   *  generally land here. */
  target: Vaddr | null;
}

/** A resolved direct branch edge. */
export interface Branch {
  source: Vaddr;
  target: Vaddr;
  kind: string;
}

/**
 * Whether this module has an instruction decoder for `arch`.
 *
 * `arm64`, `arm64e` and `x86_64` decode. Report rather than assume: a caller that
 * swept an undecodable slice and got `[]` could not tell "cannot decode this
 * architecture" from "there was nothing there", and those are different answers.
 */
export declare function supportedArch(arch: string): boolean;

/**
 * Length in bytes of the instruction at `offset` in `bytes`, or `null`.
 *
 * `null` covers three cases that a caller may want to tell apart but cannot from
 * the return value alone: an unknown architecture, an unknown opcode, and a
 * truncated buffer. `address` is only meaningful when a length came back.
 *
 * The tables are incomplete by design and list their gaps in `instruction.mjs`:
 * 3DNow!, AMD `extrq`/`insertq`, and EVEX opcodes with an immediate are read one
 * byte short. A short reading is the least damaging failure available — the sweep
 * desynchronises at that instruction — because a length that is merely *too long*
 * hides the instruction behind it.
 */
export declare function instructionLength(
  arch: string,
  bytes: Buffer,
  offset?: number,
): number | null;

/**
 * Resolved direct branch target of the instruction at `offset`, or `null`.
 *
 * `pc` is the virtual address of the first byte, because both architectures
 * measure their displacements from there: x86_64 from the instruction's *end*,
 * arm64 from the instruction's start.
 *
 * Only direct-relative forms resolve. RIP-relative operands on x86_64 and the
 * register-indirect forms on both architectures name a target this cannot
 * compute, and `null` is the honest answer.
 */
export declare function branchTarget(
  arch: string,
  bytes: Buffer,
  pc: Vaddr,
  offset?: number,
): Branch | null;

/**
 * Sweep a code section in address order and return every instruction decoded.
 *
 * This is a **linear sweep**, not a recursive descent, and the distinction is the
 * whole caveat: it decodes every byte of the range, so alignment padding and any
 * data interleaved into the code section are read as instructions. It is a
 * coverage tool for a range you already believe is code, not a way to find code.
 *
 * Measured against `/usr/lib/dyld`, 91.0% of a slice's symbols landed on an
 * instruction boundary when the sweep began at the section start, against 100%
 * when each sweep began at its own symbol's address. Start from a symbol.
 *
 * Reads are windowed rather than done in one buffer: a large `__text` is read in
 * 64 KiB windows with a carry, so an instruction straddling a window boundary is
 * decoded once, in the right place, rather than dropped and then re-decoded from
 * the wrong offset.
 */
export declare function disassemble(
  path: string,
  opts?: {
    /** Where to start, as a virtual address. Must lie in a code section of a
     *  matching slice. Omit to start at the section's first byte — see the
     *  linear-sweep note above before relying on that. */
    addr?: Vaddr | null;
    /** Architecture preference, not a filter: if absent, another slice is read. */
    arch?: string | null;
    /** Stop after this many instructions. `0` means no cap. Default 32. */
    count?: number;
    /** Decode this many bytes instead of counting instructions. `0` means no cap. */
    bytes?: number;
  },
): {
  slices: Array<{
    arch: string;
    offset: number;
    section: string;
    sectionAddr: Vaddr;
    sectionSize: number;
    startAddr: Vaddr;
    instructions: Instruction[];
    branches: Branch[];
  }>;
  /** Architecture names that appeared and could not be decoded. */
  unsupported: string[];
  notes: string[];
};
