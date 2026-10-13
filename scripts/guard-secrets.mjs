#!/usr/bin/env node
// Refuses a commit that would record a credential.
//
// This exists because one did get recorded: a Google OAuth client secret sat in
// .env.example -- a tracked file, the one people copy credentials into by
// accident -- and stayed there across commits on a branch.
//
// It scans what is about to be committed, not the working tree, so it sees
// exactly what the commit would contain.
//
// ## Two things this deliberately does not do
//
// It ignores comments. This file, and any well-commented source, describes
// credential shapes; a guard that refuses to be committed alongside its own
// source is a guard nobody keeps.
//
// And it resolves the repository with `git rev-parse`, never from its own
// location. The usual version of this script derives the root from
// import.meta.url, which is correct at scripts/ and silently wrong when the
// same file is copied to .git/hooks/ -- where it resolves to .git, makes git
// diff run against .git as though it were the repository, and returns the
// entire index instead of the staged diff. That failure is invisible: the hook
// runs, finds nothing, and passes.
//
// Usage:
//   ln -s ../../scripts/guard-secrets.mjs .git/hooks/pre-commit   # from .git/hooks
//   node scripts/guard-secrets.mjs                                # by hand
//
// Bypass one commit with: git commit --no-verify

import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function git(args, cwd) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return res.status === 0 ? res.stdout : '';
}

// The repository, from git rather than from this file. `git rev-parse` works
// from anywhere inside a work tree, including .git/hooks.
const REPO_ROOT = git(['rev-parse', '--show-toplevel'], process.cwd()).trim();
if (!REPO_ROOT) {
  console.error('guard-secrets: not inside a git repository; refusing to pass silently.');
  process.exit(1);
}

// Comment markers, stripped before any pattern runs.
const COMMENT_RE = /(^|\s)(#|\/\/|<!--|\*|\/\*)/;

const RULES = [
  {
    name: 'Google OAuth client secret',
    pattern: /\bGOCSPX-[A-Za-z0-9_-]{20,}/,
    why: 'regenerate it in the Google Cloud console; do not edit the file holding it',
  },
  {
    name: 'Google API key',
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/,
    why: 'restrict or regenerate it in the Google Cloud console',
  },
  {
    name: 'AWS access key id',
    pattern: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/,
    why: 'rotate the credential',
  },
  {
    name: 'private key block',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    why: 'a private key cannot be un-leaked, only rotated',
  },
  {
    name: 'GitHub token',
    pattern: /\b(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})\b/,
    why: 'revoke it at github.com/settings/tokens',
  },
  {
    name: 'Slack token',
    pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
    why: 'revoke it in the Slack app configuration',
  },
  {
    name: 'signed token (JWT)',
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
    why: 'work out what it grants, then revoke it',
  },
  {
    name: 'database URL with a password',
    pattern: /\b(postgres|postgresql|mysql|redis):\/\/[^\s:/@"']+:[^\s:@/"']+@/,
    why: 'put it in the environment, not in a tracked file',
    allow: [
      // The local development conventions, and the usual example hosts. These
      // are credentials that exist only in docker-compose.dev.yml and the
      // readme, and refusing them would train people to reach for --no-verify.
      /:\/\/([^:]+):(ghostmplay|postgres|root|user|admin|example|changeme|password|secret|test|dev|localhost|xxx+)\@(localhost|127\.0\.0\.1|0\.0\.0\.0|db|postgres)/,
      /:\/\/[^:]*:(example|placeholder|redacted|your[-_]?password|xxx+|[<{])/i,
    ],
  },
];

function stagedFiles() {
  return git(['diff', '--cached', '--name-only', '--diff-filter=ACM'], REPO_ROOT)
    .split('\n')
    .filter(Boolean);
}

function addedLines(file) {
  // --unified=0 gives only the added text, with no surrounding context.
  const out = git(['diff', '--cached', '--unified=0', '--no-color', '--', file], REPO_ROOT);
  const lines = [];
  for (const line of out.split('\n')) {
    if (!line.startsWith('+') || line.startsWith('+++')) continue;
    lines.push(line.slice(1));
  }
  return lines;
}

// Strips the comment part of a line, so this file and any well-commented source
// can still be committed. What remains is code, where a credential is a real
// finding rather than a description of one.
function stripComment(line) {
  const at = line.search(COMMENT_RE);
  return at === -1 ? line : line.slice(0, at);
}

const files = stagedFiles();
if (files.length === 0) process.exit(0);

const findings = [];
for (const file of files) {
  for (const raw of addedLines(file)) {
    const line = stripComment(raw);
    if (!line.trim()) continue;

    for (const rule of RULES) {
      if (!rule.pattern.test(line)) continue;
      if (rule.allow?.some((p) => p.test(line))) continue;
      findings.push({ file, rule, line: raw.trim() });
    }
  }
}

if (findings.length === 0) process.exit(0);

console.error('\n  Refusing the commit: it would record a credential.\n');
const seen = new Set();
for (const f of findings) {
  const key = `${f.file}:${f.rule.name}`;
  if (seen.has(key)) continue;
  seen.add(key);

  const shown = f.line.slice(0, 96);
  console.error(`  ${f.file}`);
  console.error(`    looks like a ${f.rule.name}`);
  console.error(`    ${shown}${f.line.length > 96 ? '…' : ''}`);
  console.error(`    ${f.rule.why}\n`);
}
console.error('  If it is a placeholder, replace it with an obviously-fake value\n');
console.error('  rather than deleting the line: a real secret left in place is the\n');
console.error('  case this cannot catch afterwards.\n');
console.error('  Bypass for one commit:  git commit --no-verify\n');

process.exit(1);