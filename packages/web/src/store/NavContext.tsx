/**
 * NavContext — top-nav visibility toggle.
 *
 * On mobile, the user can collapse the top nav (Agents / Onboarding links)
 * to reclaim its ~56px height for the terminal. The toggle button lives in
 * PtySessionViewMobile (always reachable at fixed top-right). The actual
 * `.app-nav` element lives in App.tsx — both consume this context.
 *
 * Desktop users don't see the toggle button, so the `navHidden` state is
 * effectively inert on desktop (CSS rule is mobile-scoped).
 */

import { createContext, useCallback, useContext, useState } from 'react';
import type { ReactNode } from 'react';

interface NavContextValue {
  navHidden: boolean;
  toggleNav: () => void;
}

const NavContext = createContext<NavContextValue>({
  navHidden: false,
  toggleNav: () => {
    /* default no-op so consumers outside a Provider don't crash */
  },
});

export function NavProvider({ children }: { children: ReactNode }) {
  const [navHidden, setNavHidden] = useState(false);
  const toggleNav = useCallback(() => setNavHidden((v) => !v), []);
  return (
    <NavContext.Provider value={{ navHidden, toggleNav }}>
      {children}
    </NavContext.Provider>
  );
}

export function useNav(): NavContextValue {
  return useContext(NavContext);
}