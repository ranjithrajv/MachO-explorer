# Releasing

The publish path is a **tag**, not a command a maintainer runs by hand. That is
deliberate: `npm publish --dry-run` reports success on a name the registry
refuses, so the hand-run publish is the one step in this project with a history
of a check that could not fail. `.github/workflows/release.yml` is the only
publish path, and it re-runs the gate first.

## One-time setup

1. Create an npm automation token (or configure
   [trusted publishing](https://docs.npmjs.com/trusted-publishers) for the repo).
2. Add it as the `NPM_TOKEN` repository secret.

## Cut a release

```sh
# 1. Everything green, on the exact commit you are about to tag.
node test/fixtures.mjs --check
node test/smoke.mjs
node test/disasm.mjs
node test/browser.mjs
node test/conformance.mjs
node test/mcp.mjs
node test/skill.mjs
node test/publish.mjs

# 2. Move the version and the changelog together.
#    package.json "version" and the CHANGELOG heading must agree.

# 3. Commit, tag, push. The tag is the version.
git commit -am "Release 0.2.0"
git tag -a v0.2.0 -m "0.2.0"
git push origin main --follow-tags
```

Pushing the tag triggers the release workflow, which re-runs the gate, checks
that `vX.Y.Z` matches `package.json`'s `version`, and publishes with
[provenance](https://docs.npmjs.com/generating-provenance-statements).

A **prerelease** tag — one containing a `-`, such as `v0.1.0-alpha.1` — is
deliberately skipped by that workflow. An alpha must not become npm's `latest`,
and publishing a GitHub release creates the very tag the workflow listens for,
so without the guard, cutting the alpha would publish it.

## If the tag and the manifest disagree

The workflow fails before publishing. That is the point: a tag `v0.2.0` on a
manifest that still says `0.1.0` would publish `macho-explorer@0.1.0` under a
`v0.2.0` tag, and the two would disagree forever in the registry.

## The package name

The name is `macho-explorer` and it must stay lowercase — npm refuses a capital
letter in a name published for the first time, and `npm publish --dry-run` will
**not** tell you. `test/publish.mjs` asserts the name, the character rules, every
`files` entry, every `bin` target and every `export` subpath, and runs in CI, so
the dry run is never the only witness.
