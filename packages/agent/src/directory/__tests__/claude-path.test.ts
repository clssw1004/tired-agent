/**
 * Tests for claude-path encoding/decoding utilities.
 *
 * Because the production code reads `process.platform` at runtime, these
 * tests exercise both Windows and POSIX branches by passing the optional
 * `platform_` parameter, regardless of the host OS.
 *
 * Run: `npx tsx --test packages/agent/src/directory/__tests__/claude-path.test.ts`
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
        'C--wspec--tired_agent_app',
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
        'c--users--test',
      );
    });

    it('handles path with spaces', () => {
      assert.equal(
        encodeClaudeProjectPath('C:\\Program Files\\App', 'win32'),
        'C--Program Files--App',
      );
    });

    it('handles deep nested path', () => {
      assert.equal(
        encodeClaudeProjectPath('C:\\a\\b\\c\\d\\e', 'win32'),
        'C--a--b--c--d--e',
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

// ─── decodeClaudeProjectPath ──────────────────────────────────────────────

describe('decodeClaudeProjectPath', () => {
  describe('Windows (platform_ = "win32")', () => {
    it('decodes a typical encoded path', () => {
      assert.equal(
        decodeClaudeProjectPath('C--wspec--tired_agent_app', 'win32'),
        'C:\\wspec\\tired_agent_app',
      );
    });

    it('restores the drive colon', () => {
      assert.equal(
        decodeClaudeProjectPath('D--', 'win32'),
        'D:\\',
      );
    });

    it('handles lower-case drive letter', () => {
      assert.equal(
        decodeClaudeProjectPath('c--users--test', 'win32'),
        'c:\\users\\test',
      );
    });

    it('throws nothing for empty input (returns just colon + drive)', () => {
      // '' → replace(/--/g, '\\') gives '' → replace drive → '' stays ''
      assert.equal(decodeClaudeProjectPath('', 'win32'), '');
    });
  });

  describe('POSIX (platform_ = "darwin" / "linux")', () => {
    it('decodes a typical encoded path', () => {
      assert.equal(
        decodeClaudeProjectPath('home-dev-work-project', 'darwin'),
        '/home/dev/work/project',
      );
    });

    it('prepends the leading slash', () => {
      assert.equal(
        decodeClaudeProjectPath('usr-local-bin', 'linux'),
        '/usr/local/bin',
      );
    });

    it('handles single-segment path', () => {
      assert.equal(
        decodeClaudeProjectPath('tmp', 'darwin'),
        '/tmp',
      );
    });

    it('handles empty input', () => {
      assert.equal(decodeClaudeProjectPath('', 'linux'), '/');
    });

    it('decodes path with spaces', () => {
      assert.equal(
        decodeClaudeProjectPath('home-user-My Project', 'linux'),
        '/home/user/My Project',
      );
    });
  });
});

// ─── Round-trip (symmetry) ────────────────────────────────────────────────

describe('round-trip symmetry', () => {
  const windowsPaths = [
    'C:\\wspec\\tired_agent_app',
    'D:\\',
    'C:\\Program Files\\App',
    'C:\\a\\b\\c\\d\\e\\f',
    'c:\\USERS\\Test\\PATH',
  ];

  for (const p of windowsPaths) {
    it(`Windows round-trip: ${p}`, () => {
      assert.equal(
        decodeClaudeProjectPath(encodeClaudeProjectPath(p, 'win32'), 'win32'),
        p,
      );
    });
  }

  const posixPaths = [
    '/home/dev/work/project',
    '/',
    '/tmp',
    '/usr/local/bin',
    '/home/user/My Project',
    '/var/log/app/1/2/3',
  ];

  for (const p of posixPaths) {
    it(`POSIX round-trip: ${p}`, () => {
      assert.equal(
        decodeClaudeProjectPath(
          encodeClaudeProjectPath(p, 'linux'),
          'linux',
        ),
        p,
      );
    });
  }
});
