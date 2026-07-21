/**
 * DirectoryPickerModal — browse the remote Agent's filesystem when
 * creating a new session, plus quick access to favorites / recents.
 *
 * The modal talks to the Agent through the shared `transport` so the
 * Manager proxy / direct Agent path is handled identically to the rest
 * of the SPA. We never call `fetch` directly here.
 *
 * UX:
 *   - Header shows the current path and a "← 上一级" button.
 *   - The body is split: shortcuts (favorites + recents) above the
 *     current directory listing.
 *   - Clicking a shortcut picks the path immediately and closes the
 *     modal. Clicking a directory entry navigates into it.
 *   - "选择当前目录" and "收藏当前目录" live in a sticky footer.
 *
 * The modal is fully controlled — it never mutates the parent until the
 * user confirms via onSelect() or cancels via onClose().
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  DirectoryEntry,
  DirectoryFavorite,
  DirectoryListing,
  RecentDirectory,
} from '@tired-agent/protocol';
import { transport } from '../api/transport';
import type { AgentServerRef } from '../store/ServerContext';

export interface DirectoryPickerModalProps {
  server: AgentServerRef;
  /** Initial path to open. Falls back to the Agent's home directory. */
  value?: string;
  /** Called with the chosen absolute path; the modal then closes. */
  onSelect: (path: string) => void;
  /** Called when the user dismisses the modal without choosing. */
  onClose: () => void;
}

export function DirectoryPickerModal({
  server,
  value,
  onSelect,
  onClose,
}: DirectoryPickerModalProps) {
  const [currentPath, setCurrentPath] = useState(value ?? '');
  const [parent, setParent] = useState<string | null>(null);
  const [entries, setEntries] = useState<DirectoryEntry[]>([]);
  const [favorites, setFavorites] = useState<DirectoryFavorite[]>([]);
  const [recent, setRecent] = useState<RecentDirectory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savingFavorite, setSavingFavorite] = useState(false);

  // Escape to dismiss — mirrors the shared `Modal` primitive so the
  // muscle memory of the rest of the SPA carries over.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Navigate to an arbitrary path. Used by the initial load, the "up"
  // button, and shortcut clicks. On a successful load we sync the
  // local state to whatever the server reports (it may have normalized
  // the path or redirected to the home directory when the input was
  // empty).
  //
  // To avoid races when the user clicks quickly through a chain of
  // directories we tag each request with a monotonically increasing
  // sequence number; only the latest in-flight request is allowed to
  // mutate state. Stale responses and stale errors are discarded.
  //
  // Returns the listing on success, or `null` on failure / when the
  // response was superseded — callers (e.g. `pickShortcut`) use this
  // to decide whether to confirm the selection.
  const requestSeqRef = useRef(0);
  const loadListing = useCallback(
    async (path?: string): Promise<DirectoryListing | null> => {
      const myId = ++requestSeqRef.current;
      setLoading(true);
      setError(null);
      try {
        const listing: DirectoryListing = await transport.listDirectories(
          server,
          path || undefined,
          server.agentId,
        );
        if (myId !== requestSeqRef.current) return null;
        setCurrentPath(listing.path);
        setParent(listing.parent);
        setEntries(listing.entries);
        return listing;
      } catch (err) {
        if (myId !== requestSeqRef.current) return null;
        setError((err as Error).message);
        return null;
      } finally {
        if (myId === requestSeqRef.current) setLoading(false);
      }
    },
    [server],
  );

  // Initial effect: fetch shortcuts + first listing in parallel so the
  // modal has both sidebars ready when it paints. If either fails we
  // surface the error in place — partial data is still useful. We tag
  // the parallel pair with the same sequence number used by
  // `loadListing` so a navigation that fires immediately after the
  // initial mount doesn't get overwritten by these slower requests.
  useEffect(() => {
    const myId = ++requestSeqRef.current;
    setLoading(true);
    setError(null);
    void Promise.all([
      transport.getDirectoryShortcuts(server, server.agentId),
      transport.listDirectories(server, value || undefined, server.agentId),
    ])
      .then(([shortcuts, listing]) => {
        if (myId !== requestSeqRef.current) return;
        setFavorites(shortcuts.favorites);
        setRecent(shortcuts.recent);
        setCurrentPath(listing.path);
        setParent(listing.parent);
        setEntries(listing.entries);
      })
      .catch((err) => {
        if (myId !== requestSeqRef.current) return;
        setError((err as Error).message);
      })
      .finally(() => {
        if (myId === requestSeqRef.current) setLoading(false);
      });
  }, [server, value]);

  const isFavorited = useMemo(
    () => favorites.some((f) => f.path === currentPath),
    [favorites, currentPath],
  );

  const currentFavorite = useMemo(
    () => favorites.find((f) => f.path === currentPath),
    [favorites, currentPath],
  );

  // ── shortcut interactions ────────────────────────────────────────
  // Clicking a favorite/recent navigates to the path first; we only
  // commit the selection (and close the modal) when the server
  // confirms that path exists. A stale shortcut — e.g. the Agent was
  // reinstalled and the directory is gone — surfaces as an error and
  // leaves the modal open so the user can recover instead of having
  // a non-existent path silently written back to the form.
  const pickShortcut = async (path: string) => {
    const listing = await loadListing(path);
    if (listing) onSelect(path);
  };

  const handleEntryClick = (entry: DirectoryEntry) => {
    void loadListing(entry.path);
  };

  const handleParentClick = () => {
    if (parent) void loadListing(parent);
  };

  const handleSelectCurrent = () => {
    if (currentPath) onSelect(currentPath);
  };

  // ── favorite mutations ───────────────────────────────────────────
  // The Agent auto-generates the favorite name from the path's
  // basename — we deliberately don't pop a second modal to ask for
  // one. Removing a favorite is a no-throw fire-and-forget; the UI
  // reflects the new state from the server response.
  const handleToggleFavorite = async () => {
    if (!currentPath) return;
    if (currentFavorite) {
      setSavingFavorite(true);
      try {
        await transport.removeDirectoryFavorite(
          server,
          currentFavorite.id,
          server.agentId,
        );
        setFavorites((prev) => prev.filter((f) => f.id !== currentFavorite.id));
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setSavingFavorite(false);
      }
      return;
    }
    setSavingFavorite(true);
    try {
      const created = await transport.addDirectoryFavorite(
        server,
        { path: currentPath },
        server.agentId,
      );
      setFavorites((prev) => [...prev, created]);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSavingFavorite(false);
    }
  };

  return (
    <>
      <div
        className="modal-backdrop"
        onClick={onClose}
        aria-hidden
        data-testid="directory-backdrop"
      />
      <div
        className="modal-sheet directory-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="directory-modal-title"
      >
        <div className="modal-handle" aria-hidden />
        <div id="directory-modal-title" className="modal-title">
          选择工作目录
        </div>

        <div
          className="directory-toolbar"
          aria-label="当前目录导航"
        >
          <button
            type="button"
            className="btn-ghost directory-up-btn"
            disabled={parent === null || loading}
            onClick={handleParentClick}
            aria-label="返回上一级目录"
          >
            ← 上一级
          </button>
          <div
            className="directory-path"
            aria-label={`当前目录 ${currentPath}`}
            title={currentPath}
          >
            {currentPath || (loading ? '加载中…' : '尚未选择目录')}
          </div>
        </div>

        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button
              type="button"
              onClick={() => setError(null)}
              aria-label="关闭错误提示"
            >
              ✕
            </button>
          </div>
        )}

        <div className="directory-body">
          {(favorites.length > 0 || recent.length > 0) && (
            <div className="directory-shortcut-list">
              {favorites.length > 0 && (
                <div className="directory-shortcut-section">
                  <div className="directory-shortcut-heading">常用</div>
                  {favorites.map((fav) => (
                    <button
                      key={fav.id}
                      type="button"
                      className="directory-shortcut-item"
                      onClick={() => pickShortcut(fav.path)}
                      title={fav.path}
                    >
                      <span className="directory-shortcut-icon" aria-hidden>
                        ★
                      </span>
                      <span className="directory-shortcut-name">{fav.name}</span>
                      <span className="directory-shortcut-path">{fav.path}</span>
                    </button>
                  ))}
                </div>
              )}
              {recent.length > 0 && (
                <div className="directory-shortcut-section">
                  <div className="directory-shortcut-heading">最近</div>
                  {recent.map((r) => (
                    <button
                      key={r.path}
                      type="button"
                      className="directory-shortcut-item"
                      onClick={() => pickShortcut(r.path)}
                      title={r.path}
                    >
                      <span className="directory-shortcut-icon" aria-hidden>
                        ⏱
                      </span>
                      <span className="directory-shortcut-name">{r.path}</span>
                      <span className="directory-shortcut-path">
                        {formatRelativeTime(r.lastUsedAt)}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="directory-listing" aria-busy={loading}>
            {loading && entries.length === 0 ? (
              <div className="directory-status">加载中…</div>
            ) : entries.length === 0 ? (
              <div className="directory-status">空目录</div>
            ) : (
              <ul className="directory-entry-list" role="list">
                {entries.map((entry) => (
                  <li key={entry.path} className="directory-entry-item">
                    <button
                      type="button"
                      className="directory-entry"
                      onClick={() => handleEntryClick(entry)}
                      aria-label={`进入目录 ${entry.name}`}
                    >
                      <span className="directory-entry-icon" aria-hidden>
                        📁
                      </span>
                      <span className="directory-entry-name">{entry.name}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <div className="modal-actions directory-modal-actions">
          <button
            type="button"
            className="modal-btn modal-btn-cancel"
            onClick={onClose}
          >
            取消
          </button>
          <button
            type="button"
            className="btn-ghost"
            onClick={handleToggleFavorite}
            disabled={!currentPath || savingFavorite}
            aria-label={isFavorited ? '取消收藏当前目录' : '收藏当前目录'}
          >
            {savingFavorite
              ? '处理中…'
              : isFavorited
                ? '取消收藏'
                : '收藏当前目录'}
          </button>
          <button
            type="button"
            className="modal-btn modal-btn-confirm"
            onClick={handleSelectCurrent}
            disabled={!currentPath || loading}
          >
            选择当前目录
          </button>
        </div>
      </div>
    </>
  );
}

function formatRelativeTime(epochMs: number): string {
  if (!epochMs) return '';
  const delta = Date.now() - epochMs;
  if (delta < 60_000) return '刚刚';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`;
  return `${Math.floor(delta / 86_400_000)} 天前`;
}
