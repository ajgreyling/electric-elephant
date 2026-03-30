# Backporting from DBHub

This document describes how to backport changes from upstream `bytebase/dbhub` into `electric-elephant`, and records the backports already applied in this repository.

## Why this exists

`electric-elephant` started as a clone of DBHub, but it now has custom branding and PostgreSQL-only behavior. We still want to regularly pull in upstream fixes (especially security and reliability fixes) without blindly syncing everything.

## Backport strategy

Use a selective backport process:

1. Identify upstream commits worth backporting.
2. Check whether each commit is already present (hash or equivalent logic).
3. Port changes manually (preferred) when the fork has drifted.
4. Run targeted tests for changed areas.
5. Run build/smoke checks for packaging/runtime regressions.
6. Record the backport in this file.

## Step-by-step process

### 1) Inspect recent upstream history

From `dbhub`:

```bash
git log --date=short --pretty=format:'%h %ad %s' -n 50
```

Focus on:

- security/read-only enforcement
- connector correctness (data loss/precision)
- transport/runtime stability
- build/package/runtime loading fixes

### 2) Check if commits are already present in `electric-elephant`

```bash
git -C /path/to/electric-elephant cat-file -e <commit>^{commit}
```

If `cat-file` fails, the commit hash is absent. Even when absent, equivalent logic may already be manually ported, so verify by reading code diffs.

### 3) Review upstream patch and affected files

```bash
git show --name-status --stat <commit>
git show <commit> -- <file1> <file2> ...
```

Port only relevant parts. Skip pure upstream-branding/doc changes and non-PostgreSQL connector changes unless applicable.

### 4) Apply backport in Electric Elephant

- Prefer minimal diffs.
- Preserve Electric Elephant naming/branding.
- Keep existing fork-specific behavior unless the upstream fix should override it.
- Add/update tests in the same patch.
- **PII/clinical guard** (`src/utils/pii-sql-guard.ts`, `src/utils/pii-heuristics.ts`, `allow_access_to_pii_data`, `PII_ACCESS_VIOLATION`) is **Electric Elephant–only**. DBHub does not ship this; when backporting `execute_sql` changes from upstream, merge carefully so you do not drop or bypass the guard unintentionally.

### 5) Validate

Run focused tests first, then build checks.

Recommended pattern:

```bash
pnpm test <changed-test-file>
pnpm run build:backend
pnpm run test:build
```

For read-only/backport work, include:

- `src/utils/__tests__/allowed-keywords.test.ts`
- `src/utils/__tests__/sql-parser.test.ts`
- `src/tools/__tests__/execute-sql.test.ts` (includes PII guard / `PII_ACCESS_VIOLATION` cases)

### 6) Record backport history

For every backport, add:

- upstream commit hash + title
- status (`direct cherry-pick` or `manual port`)
- local files changed
- validation commands run

## Backport history

### Detailed commit ledger

The following upstream commits have been backported into `electric-elephant` as **manual ports** (logic-equivalent, not hash-preserving cherry-picks). Some entries mention MySQL/MariaDB/SQLite because that wording comes from upstream commit messages; treat those as historical context, not current product scope.

#### Read-only/security series (PR #275 + related fix)

- `a37ced9` - Fix: detect mutating keywords inside CTEs in read-only mode
- `04cfa48` - Fix: exclude `REPLACE()` string function from mutating keyword detection
- `4ce777a` - Fix: scope mutating scan to `WITH`, add `SELECT INTO` detection
- `e488858` - Fix: handle `WITH ... SELECT INTO`, `EXPLAIN ANALYZE`, `REPLACE()` in CTEs
- `88f9e42` - Fix: validate `EXPLAIN ANALYZE` inner statement with full read-only logic
- `20aef0e` - Fix: handle `EXPLAIN ANALYZE VERBOSE` in read-only checks
- `439fca7` - Fix: dialect-aware `REPLACE` detection (MySQL/MariaDB only)
- `7f61160` - Fix: reject standalone `ANALYZE`; allow `EXPLAIN (ANALYZE false|off|0)`
- `b37af1b` - Fix: narrow MySQL `REPLACE` detection to `REPLACE ... INTO`
- `7719d4e` - Fix: add SQLite `REPLACE INTO` detection in read-only mode
- `f3b32da` - Refactor: simplify mutating pattern dispatch/processing
- `4236ba4` - Merge commit for PR #275 (source reference)
- `409394b` - Fix: prevent readonly bypass via MySQL/MariaDB executable comments (#284)

#### Runtime/connector/build reliability series

- `bad73ad` - Fix: exit stdio transport process when parent closes on Windows
- `c772cb6` - Feat: support base64-encoded SSH private keys in SSH config
- `e1a4736` - Fix: preserve BIGINT precision for MySQL and SQLite connectors
- `1eefec4` - Feat: support optional database driver packages (#286)
- `b8d5e52` - Fix: externalize DB drivers in tsup to avoid CJS-in-ESM runtime failures (#291)
- `aab1312` - Add post-build smoke test for connector chunk imports

## 2026-03-30: Read-only security hardening batch

Status: **manual port (equivalent logic), validated**

Upstream sources:

- `4236ba4` - Fix: detect mutating keywords inside CTEs in read-only mode (#275)
- `409394b` - Fix: prevent readonly bypass via MySQL conditional comments (#284)

Local files changed:

- `src/utils/allowed-keywords.ts`
- `src/utils/sql-parser.ts`
- `src/utils/__tests__/allowed-keywords.test.ts`
- `src/utils/__tests__/sql-parser.test.ts`
- `src/tools/__tests__/execute-sql.test.ts`

Validation run:

- `pnpm test src/utils/__tests__/allowed-keywords.test.ts`
- `pnpm test src/utils/__tests__/sql-parser.test.ts`
- `pnpm test src/tools/__tests__/execute-sql.test.ts`

Notes:

- This backport closes read-only bypass vectors involving `WITH` CTE mutation, `SELECT ... INTO`, `EXPLAIN ANALYZE`, and executable MySQL/MariaDB comments.

## 2026-03-30: Runtime and packaging reliability batch

Status: **manual port (selected upstream commits), validated**

Upstream sources:

- `bad73ad` - fix: exit stdio transport process when parent closes on Windows
- `c772cb6` - feat: support base64-encoded SSH private keys in SSH_KEY
- `e1a4736` - fix: preserve BIGINT precision for MySQL and SQLite connectors
- `1eefec4` - feat: support optional database driver packages (#286)
- `b8d5e52` - Fix: externalize database drivers in tsup to prevent bundling CJS into ESM (#291)
- `aab1312` - Add post-build smoke test to catch CJS-in-ESM bundling errors

Local files changed:

- `src/server.ts`
- `src/utils/ssh-tunnel.ts`
- `src/utils/__tests__/ssh-tunnel.test.ts`
- `src/connectors/mysql/index.ts`
- `src/connectors/sqlite/index.ts`
- `src/utils/response-formatter.ts`
- `src/utils/__tests__/bigint-handling.test.ts`
- `src/index.ts`
- `src/utils/module-loader.ts`
- `src/__tests__/load-connectors.test.ts`
- `tsup.config.ts`
- `package.json`
- `scripts/smoke-test-build.mjs`

Validation run:

- `pnpm test src/utils/__tests__/ssh-tunnel.test.ts`
- `pnpm test src/utils/__tests__/bigint-handling.test.ts`
- `pnpm test src/__tests__/load-connectors.test.ts`
- `pnpm test src/tools/__tests__/execute-sql.test.ts`
- `pnpm run build:backend`
- `pnpm run test:build`

Notes:

- Drivers moved to `optionalDependencies` and connector loading is now resilient to missing driver packages.
- Added backend smoke test to detect bundled CJS-in-ESM regressions.

## Maintenance checklist

When doing future backports:

- Update this file with every backport batch.
- Keep entries chronological.
- Include exact upstream hashes and validation commands.
- If behavior intentionally differs from upstream, document the reason in the entry.
