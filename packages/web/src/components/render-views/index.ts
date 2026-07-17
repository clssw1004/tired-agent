/**
 * Renderer views — components mounted inside RenderArea.
 *
 * Currently a single TerminalView covers every CLI session. Future custom
 * views (canvas dashboards, structured tables) can be added here.
 */

export { TerminalView, type TerminalHandle } from './TerminalView';