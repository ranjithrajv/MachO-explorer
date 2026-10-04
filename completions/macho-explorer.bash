# bash completion for MachO-explorer.                           -*- shell-script -*-
#
# Registers completion for the unified `macho-explorer` CLI:
#
#     . /path/to/completions/macho-explorer.bash  # from your .bashrc
#
# The CLI takes a subcommand (`describe`, `sym`, ...) as its first argument,
# so this file completes both subcommand names and their options.
#
# Every tool here is dependency-free and runs on Linux and Windows as well as
# macOS, so completion never assumes `otool` or `lipo` exist.

# Per-tool option sets, keyed by the command name exactly as typed.
_macho_opts_for() {
    case "$1" in
        describe)     echo "--json -h --help -b --binary" ;;
        sym)          echo "--json -h --help --regex --case-sensitive --all-imp --no-dedupe --arch -b --binary" ;;
        symlookup)    echo "--json -h --help --arch -b --binary" ;;
        findcall)     echo "--json -h --help --list --include-data --arch -b --binary" ;;
        findliteral)  echo "--json -h --help --text -b --binary" ;;
        mapliteral)   echo "--json -h --help -b --binary" ;;
        a2o)          echo "--json -h --help --arch -b --binary" ;;
        o2a)          echo "--json -h --help --arch -b --binary" ;;
        disasm)       echo "--json -h --help --branches --count --bytes --arch -b --binary" ;;
        audit)        echo "--json -h --help --strict --arch -b --binary" ;;
        fingerprint)  echo "--json -h --help --arch" ;;
        diff)         echo "--json -h --help --arch --max" ;;
        overview)     echo "--json -h --help --symbols --strings --max --min --compact --arch -b --binary" ;;
        *)            echo "" ;;
    esac
}

# Complete a path that may be a Mach-O file or an application bundle.
#
# `.app` is included because every tool accepts a bundle and resolves the
# executable inside it, and `.macho` because that is the fixture extension. The
# default file completion is still offered, since the tools are named by
# convention rather than by suffix and most real binaries have no suffix.
_macho_targets() {
    local cur="${COMP_WORDS[COMP_CWORD]}"
    COMPREPLY=( $(compgen -f -X '!*@' -- "$cur") )
    compopt -o filenames 2>/dev/null
}

# Architectures worth offering. This is a preference rather than a requirement,
# so the list is a convenience and not an enumeration of what the reader accepts.
_macho_arches='x86_64 arm64'

_macho_complete() {
    local cmd="${COMP_WORDS[0]##*/}"
    local name="$cmd"
    local cur prev opts
    COMPREPLY=()
    cur="${COMP_WORDS[COMP_CWORD]}"
    prev="${COMP_WORDS[COMP_CWORD-1]}"

    # `_macho_opts_for` lists every command name; passing one it does not know
    # matches no case and silently completes nothing — a completion that always
    # returns empty looks identical to one that has no candidates, which is why
    # this is worth a test.
    opts="$(_macho_opts_for "$name")"

    # A value-taking flag is followed by its value, not by another option.
    case "$prev" in
        -b|--binary) _macho_targets; return 0 ;;
        --arch)      COMPREPLY=( $(compgen -W "$_macho_arches" -- "$cur") ); return 0 ;;
        --arch=*)    COMPREPLY=( $(compgen -W "$_macho_arches" -- "${cur#*=}") ); return 0 ;;
        # `disasm` is the only tool with a positional that is neither a query nor
        # a path, so its count can be a bare number with no flag in front of it.
        --count|--bytes)
            COMPREPLY=( $(compgen -W '0 1 8 16 32 64 128 256 512 1024 4096' -- "$cur") )
            return 0 ;;
        --max)
            COMPREPLY=( $(compgen -W '0 100 1000 4000 10000' -- "$cur") )
            return 0 ;;
        --min)
            COMPREPLY=( $(compgen -W '3 4 6 8' -- "$cur") )
            return 0 ;;
    esac

    if [[ "$cur" == --arch=* ]]; then
        COMPREPLY=( $(compgen -W "$_macho_arches" -- "${cur#*=}") )
        # Keep the prefix the user already typed.
        COMPREPLY=( "${COMPREPLY[@]/#/--arch=}" )
        return 0
    fi

    # Everything starting with a dash that is in this tool's option set.
    if [[ "$cur" == -* ]]; then
        COMPREPLY=( $(compgen -W "$opts" -- "$cur") )
        return 0
    fi

    # Otherwise a path. The first positional is a query — a pattern for sym, an
    # address for symlookup, a2o and o2a, a call target for findcall, a byte
    # literal for findliteral and mapliteral — so a path is only correct once
    # those are filled. `_macho_targets` handles the common case of one query and
    # one path without trying to know which position we are in.
    _macho_targets
}

# Complete subcommand names after `macho-explorer`
_macho_subcommands() {
    local cur="${COMP_WORDS[COMP_CWORD]}"
    COMPREPLY=( $(compgen -W "describe sym symlookup findcall findliteral mapliteral a2o o2a disasm audit fingerprint diff overview mcp" -- "$cur") )
    return 0
}

# Register the unified CLI
complete -F _macho_complete macho-explorer

# Sourced rather than executed: `complete` and `compgen` only exist inside an
# interactive bash, and running this file as a script would exit on the first of
# them.