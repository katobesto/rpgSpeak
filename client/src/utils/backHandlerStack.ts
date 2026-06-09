/**
 * Global stack of "back" handlers.
 *
 * Components that render a modal / overlay push a close callback when they
 * open and remove it when they close.  The App-level popstate handler pops
 * the top handler instead of letting the browser navigate away.
 *
 * LIFO order means the most-recently-opened overlay always closes first.
 */

const handlers: Array<() => void> = [];

export const backHandlerStack = {
  push(fn: () => void): void {
    handlers.push(fn);
  },

  /** Remove a specific handler (by reference) — used on cleanup. */
  remove(fn: () => void): void {
    const idx = handlers.lastIndexOf(fn);
    if (idx !== -1) handlers.splice(idx, 1);
  },

  /** Pop and return the top handler, or null if the stack is empty. */
  pop(): (() => void) | null {
    return handlers.length > 0 ? handlers.pop()! : null;
  },

  hasAny(): boolean {
    return handlers.length > 0;
  },
};
