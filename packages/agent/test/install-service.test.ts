/**
 * Unit tests for the service-lifecycle module in src/install-service.ts.
 *
 * Only pure config generation and platform helpers are exercised here — the
 * lifecycle commands (install/uninstall/update) shell out to systemctl/
 * launchctl/npm and MUST NOT be invoked from tests. These tests never touch
 * the running agent (8444), its unit file, or any real data directory.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { homedir } from 'node:os';

import {
  buildLaunchdPlist,
  buildProgramArgs,
  buildSystemdUnit,
  detectPlatform,
  serviceConfigPath,
} from '../src/install-service.js';

const ARGS = ['/usr/bin/node', '/usr/lib/node_modules/@tired-agent/agent/dist/cli.js', 'start'];

// ─── buildSystemdUnit ──────────────────────────────────────────

test('buildSystemdUnit embeds the program command and systemd supervision', () => {
  const unit = buildSystemdUnit(ARGS);
  assert.match(unit, /\[Unit\]/);
  assert.match(unit, /Description=tired-agent PTY executor daemon/);
  assert.match(
    unit,
    /ExecStart=\/usr\/bin\/node \/usr\/lib\/node_modules\/@tired-agent\/agent\/dist\/cli\.js start/,
  );
  assert.match(unit, /Restart=always/);
  assert.match(unit, /RestartSec=3/);
  assert.match(unit, /TimeoutStopSec=15/);
  assert.match(unit, /KillSignal=SIGTERM/);
  assert.match(unit, /WantedBy=default\.target/);
  // ExecStart must not carry a trailing comment — systemd would treat it
  // as extra arguments.
  const execLine = unit.split('\n').find((l) => l.startsWith('ExecStart='));
  assert.ok(execLine && !execLine.includes('#'), 'ExecStart must not have an inline comment');
});

test('buildSystemdUnit keeps the --register flag in ExecStart', () => {
  const unit = buildSystemdUnit([...ARGS, '--register', 'abc123']);
  assert.match(unit, /ExecStart=.* start --register abc123$/m);
});

// ─── buildLaunchdPlist ─────────────────────────────────────────

test('buildLaunchdPlist produces a launchd LaunchAgent plist', () => {
  const plist = buildLaunchdPlist(ARGS, '/home/user/.tiredagent');
  assert.match(plist, /<key>Label<\/key>\s*<string>com\.tiredagent\.agent<\/string>/);
  assert.match(plist, /<key>ProgramArguments<\/key>/);
  assert.match(plist, /\/usr\/bin\/node<\/string>/);
  assert.match(plist, /dist\/cli\.js<\/string>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(plist, /<key>WorkingDirectory<\/key>\s*<string>\/home\/user\/\.tiredagent<\/string>/);
  assert.match(plist, /StandardOutPath<\/key>/);
  assert.match(plist, /launchd\.out\.log<\/string>/);
  assert.match(plist, /StandardErrorPath<\/key>/);
  assert.match(plist, /launchd\.err\.log<\/string>/);
});

test('buildLaunchdPlist escapes XML special characters', () => {
  const plist = buildLaunchdPlist(['/usr/bin/node', '/x & <y>/cli.js', 'start'], '/home/u/.tiredagent');
  assert.match(plist, /\/x &amp; &lt;y&gt;\/cli\.js/);
});

// ─── buildProgramArgs ──────────────────────────────────────────

test('buildProgramArgs returns <node> <script> start', () => {
  const args = buildProgramArgs();
  assert.equal(args[0], process.execPath);
  assert.equal(args[2], 'start');
});

test('buildProgramArgs appends --register when provided', () => {
  const args = buildProgramArgs('Zm9v');
  assert.deepEqual(args.slice(3), ['--register', 'Zm9v']);
});

// ─── platform helpers (real platform only — no mocking) ────────

test('detectPlatform maps the current platform', () => {
  const p = process.platform;
  const expected =
    p === 'linux' ? 'linux'
    : p === 'darwin' ? 'darwin'
    : p === 'win32' ? 'win32'
    : 'unsupported';
  assert.equal(detectPlatform(), expected);
});

test('serviceConfigPath points at the platform service config', () => {
  const p = serviceConfigPath();
  if (process.platform === 'linux') {
    assert.equal(p, join(homedir(), '.config', 'systemd', 'user', 'tired-agent.service'));
  } else if (process.platform === 'darwin') {
    assert.equal(p, join(homedir(), 'Library', 'LaunchAgents', 'com.tiredagent.agent.plist'));
  } else {
    assert.equal(p, '');
  }
});
