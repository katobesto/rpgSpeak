import { useEffect, useRef } from 'react';
import { backHandlerStack } from '../utils/backHandlerStack.ts';

/**
 * Register a back-handler while `active` is true.
 *
 * When the user triggers the mobile swipe-back gesture (popstate), the
 * App-level handler pops the top of the backHandlerStack instead of
 * navigating away.  Use this hook in any modal/overlay/panel so that
 * the back gesture closes it before reaching the sidebar toggle.
 *
 * The `onBack` callback is kept in a ref so it never needs to be a
 * stable reference — the handler always calls the latest version.
 */
export function useBackHandler(active: boolean, onBack: () => void): void {
  const callbackRef = useRef(onBack);
  useEffect(() => { callbackRef.current = onBack; });

  useEffect(() => {
    if (!active) return;
    const handler = () => callbackRef.current();
    backHandlerStack.push(handler);
    return () => backHandlerStack.remove(handler);
  }, [active]);
}
