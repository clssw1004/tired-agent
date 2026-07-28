/**
 * Tests for claude-path encoding/decoding utilities.
 *
 * Run: `npx tsx --test packages/agent/src/directory/__tests__/claude-path.test.ts`
 *
 * NOTE: The Claude Code project directory naming scheme is COLLAPSING
 * (multiple input characters map to the same output `-`), so decoding
 * is lossy by design. Tests focus on encode correctness; decode is
 * best-effort and tested with a single representative case.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  decodeClaudeProjectPath,
  encodeClaudeProjectPath,
} from '../claude-path.js';

// ─── encodeClaudeProjectPath ──────────────────────────────────────────────

describe('encodeClaudeProjectPath', () => {
  describe('Windows (platform_ = "win32")', () => {
    it('encodes a typical absolute path', () => {
      assert.equal(
        encodeClaudeProjectPath('C:\\wspec\\tired_agent_app', 'win32'),
        'C--wspec-tired-agent-app',
      );
    });

    it('handles a short drive-root path', () => {
      assert.equal(
        encodeClaudeProjectPath('D:\\', 'win32'),
        'D--',
      );
    });

    it('handles lower-case drive letter', () => {
      assert.equal(
        encodeClaudeProjectPath('c:\\users\\test', 'win32'),
        'c--users-test',
      );
    });

    it('handles path with spaces', () => {
      assert.equal(
        encodeClaudeProjectPath('C:\\Program Files\\App', 'win32'),
        'C--Program Files-App',
      );
    });

    it('handles deep nested path', () => {
      assert.equal(
        encodeClaudeProjectPath('C:\\a\\b\\c\\d\\e', 'win32'),
        'C--a-b-c-d-e',
      );
    });
  });

  describe('POSIX (platform_ = "darwin" / "linux")', () => {
    it('encodes a typical home path', () => {
      assert.equal(
        encodeClaudeProjectPath('/home/dev/my-project', 'darwin'),
        'home-dev-my-project',
      );
    });

    it('strips the leading slash', () => {
      assert.equal(
        encodeClaudeProjectPath('/usr/local/bin', 'linux'),
        'usr-local-bin',
      );
    });

    it('handles root path', () => {
      assert.equal(
        encodeClaudeProjectPath('/', 'linux'),
        '',
      );
    });

    it('handles single-level path', () => {
      assert.equal(
        encodeClaudeProjectPath('/tmp', 'darwin'),
        'tmp',
      );
    });

    it('handles path with spaces', () => {
      assert.equal(
        encodeClaudeProjectPath('/home/user/My Project', 'linux'),
        'home-user-My Project',
      );
    });
  });
});

// ─── decodeClaudeProjectPath (best-effort, lossy) ──────────────────────────

describe('decodeClaudeProjectPath (best-effort)', () => {
  it('decodes a typical Windows encoding', () => {
    // Decoder replaces the first `-` after the drive letter with `:`
    // and all remaining `-` with `_`. This is lossy but matches the
    // typical use case where the caller just needs a display path.
    assert.equal(
      decodeClaudeProjectPath('C--wspec-tired-agent-app', 'win32'),
      'C:_wspec_tired_agent_app',
    );
  });

  it('decodes a typical POSIX encoding', () => {
    assert.equal(
      decodeClaudeProjectPath('home-dev-myproject', 'darwin'),
      '/home/dev/myproject',
    );
  });

  it('decodes empty encoding to root', () => {
    assert.equal(
      decodeClaudeProjectPath('', 'linux'),
      '/',
    );
  });
});

// ─── round-trip symmetry (POSIX only) ─────────────────────────────────────

describe('round-trip symmetry', () => {
  const posixPaths = [
    '/home/dev/work/project',
    '/usr/local/bin',
    '/tmp',
    '/home/user/My Project',
    '/a/b/c/d/e',
    // Paths with literal `-` are not reversible on POSIX because encode
    // and decode both treat `-` as a separator token.
  ];

  for (const p of posixPaths) {
    it(`POSIX round-trip: ${p}`, () => {
      assert.equal(
        decodeClaudeProjectPath(encodeClaudeProjectPath(p, 'linux'), 'linux'),
        p,
      );
    });
  }
});
