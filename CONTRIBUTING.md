# Contributing to sentinel

## Prerequisites

- Node.js 22 or 24. CI runs both.
- npm, at the version that `packageManager` in `package.json` names (`corepack enable npm`).

## Scripts

| Command | What it does |
|---|---|
| `npm ci` | Installs the locked dependencies. |
| `npm run type-check` | Runs `tsc --noEmit` over `src/`. |
| `npm test` | Runs the Vitest suite once. |
| `npm run build` | Builds the library (`tsc`) and the service worker (`vite build`) into `dist/`. |
| `scripts/release-docs.sh` | Checks that `CHANGELOG.md` and `RELEASE_NOTES.md` lead with the same dated version. |

Run `npm run type-check`, `npm test` and `npm run build` before you push. CI runs the same three on Node 22 and 24.

## Conventional Commits

Commit messages and PR titles follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/). The `pr_title` check enforces the PR title, which becomes the squash commit.

```
<type>[optional scope]: <description>
```

Types are `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`, `perf`, `ci` and `build`. Mark a breaking change with `!` after the type or a `BREAKING CHANGE:` footer.

```
fix(token-manager): share one in-flight token acquisition
feat(config)!: replace protectedDomains with protectedHosts
```

## PR conventions

- Branches are `fix/<topic>`, `feat/<topic>`, or `chore/<topic>`.
- Close each issue with its own keyword, as in `Closes #14, closes #15`. A comma-separated list after one keyword closes only the first issue.
- `main` takes squash or rebase merges only, and needs one approving review.

## CHANGELOG and release notes

A PR that changes behaviour adds an entry to two files, in the same PR. `main` is PR-protected, so an entry left for later costs a second, docs-only PR before the release can be tagged.

1. **`CHANGELOG.md`.** Add the change under the version it ships in, as in `## [0.2.0] — 2026-12-01`. There is no `[Unreleased]` section. The version follows from the change's API surface, not its intent: a new export is a minor release even in a bug-fix PR. Ask in the PR if you are unsure. The heading needs a `YYYY-MM-DD` date, but it does not have to match the tag day.
2. **`RELEASE_NOTES.md`.** Add a `## v<version>` section for the same version. Open with who is affected and what they need to do. The publish workflow uses the file's top section as the GitHub release body.

Both files are newest first, so a new version's section goes at the top. Two PRs for the same release add to the same section.

**Exemption.** A PR that changes no shipped behaviour, such as documentation, tests, CI or tooling, needs neither entry. It ships with the next release. The **Release docs** CI job decides by path: a changed file under `src/` that is not a `*.test.ts` requires both entries. If such a change ships no behaviour, such as a comment or an internal rename, apply the `no-release-notes` label. The job also fails when the two files lead with different versions.

## Releasing

1. Merge the PRs for the release. Their entries are already in both files.
2. Run the **Release** workflow with the bump type. It fails unless both files lead with the new version, then opens a `release/vX.Y.Z` PR that bumps `package.json`.
3. Merge the release PR. **Tag release** pushes `vX.Y.Z`, and **Publish** starts.
4. Approve the `npm-publish` environment. Publish checks the docs again, publishes to npm with provenance, then creates the GitHub release from the top section of `RELEASE_NOTES.md`.
