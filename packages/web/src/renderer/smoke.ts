// Standalone smoke for the renderer engine. Run with:
//   tsx packages/web/src/renderer/smoke.ts
//
// Confirms the three pipelines emit StructuredContent[] correctly without
// pulling in React + the Vite toolchain.

import { ClaudeRenderer } from './builtins/claude.js';
import { GenericPtyRenderer } from './builtins/generic-pty.js';
import { defaultRegistry } from './registry.js';
import { claudeDetector } from './builtins/claude.js';
import { genericPtyDetector } from './builtins/generic-pty.js';

function dump(label: string, contents: { type: string; text?: string }[]) {
  console.log(`---- ${label} (${contents.length} blocks) ----`);
  for (const c of contents) {
    console.log(`  [${c.type}] ${(c.text ?? '').slice(0, 80)}`);
  }
}

const reg = defaultRegistry();
reg.register({ detector: claudeDetector(), factory: () => new ClaudeRenderer() });
reg.register({ detector: genericPtyDetector(), factory: () => new GenericPtyRenderer() });

// 1. claude cmd selection
const r1 = reg.select('claude', [], '');
console.log('select("claude", [], "") ->', r1.id === 'claude' ? 'OK' : 'FAIL got ' + r1.id);

// 2. preview-based detection (no cmd, TUI markers in output)
const preview = String.fromCharCode(0x1B) + '[38;5;174m' + '● 你好' + String.fromCharCode(0x1B) + '[0m';
const r2 = reg.select('', [], preview);
console.log('select("", [], preview●) ->', r2.id === 'claude' ? 'OK' : 'FAIL got ' + r2.id);

// 3. bash fallback to generic
const r3 = reg.select('bash', [], '');
console.log('select("bash", [], "") ->', r3.id === 'generic-pty' ? 'OK' : 'FAIL got ' + r3.id);

// 4. Generic renderer: SGR colour preserved, cursor CSI dropped
{
  const g = new GenericPtyRenderer();
  let out = g.processChunk(
    String.fromCharCode(0x1B) + '[38;5;174mhello' + String.fromCharCode(0x1B) + '[0m' +
      'there' + String.fromCharCode(0x1B) + '[2;5H' +  // cursor move → drop
      'next line\n',
    { session: { cmd: 'bash', args: [] }, streaming: true, segmentContent: [] },
  );
  const tail = g.flush();
  out = { ...out, contents: [...out.contents, ...tail.contents] };
  dump('generic-pty smoke', out.contents);
}

// 5. Claude renderer: split spinner / answer / divider
{
  const c = new ClaudeRenderer();
  const sep = '\n';
  const chunk =
    // spinner redraw 1 (replaced immediately)
    String.fromCharCode(0x1B) + '[2K' + '⠂ Cultivating… (1s · thinking)' + sep +
    // answer header
    '● 你好！有什么我可以帮你的吗？' + sep +
    // continued answer
    String.fromCharCode(0x1B) + '[2m' + '下面是可选的回复。' + String.fromCharCode(0x1B) + '[22m' + sep +
    // spinner redraw 2 (after another \r)
    '\r⠐ Cultivating… (2s · thinking)' + sep +
    // divider
    '────────────────────' + sep +
    '完成。';
  const out = c.processChunk(chunk, { session: { cmd: 'claude', args: [] }, streaming: true, segmentContent: [] });
  dump('claude smoke', out.contents);
}
