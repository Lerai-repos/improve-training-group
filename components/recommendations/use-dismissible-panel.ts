'use client';

import { useCallback, useEffect, useRef } from 'react';

/**
 * A toolbar panel that closes the way every dropdown does.
 *
 * Extracted from `recommendations-view.tsx` when the second panel arrived: the same
 * forty lines twice is two chances for one of them to forget the iframe case, and the
 * view was already past the 250-line rule.
 */

export interface DismissiblePanel<T extends HTMLElement = HTMLDivElement> {
  /** Wrap the trigger AND the panel — a click inside this is "still working in it". */
  areaRef: React.RefObject<T | null>;
  /** Held by the parent so closing can put focus back on the trigger. */
  triggerRef: React.RefObject<HTMLButtonElement | null>;
  /** Close and return focus. For Sluiten and Escape. */
  close: () => void;
}

export function useDismissiblePanel<T extends HTMLElement = HTMLDivElement>(
  open: boolean,
  onClose: () => void,
  options: { enabled?: boolean } = {}
): DismissiblePanel<T> {
  const areaRef = useRef<T | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const { enabled = true } = options;

  /**
   * Closing must return focus to the trigger.
   *
   * Every deliberate way out unmounts the focused element, and the browser then drops
   * focus to `document.body` — sending a keyboard user back to the top of the page
   * instead of to the button they opened.
   */
  const close = useCallback((): void => {
    onClose();
    triggerRef.current?.focus();
  }, [onClose]);

  useEffect(() => {
    if (!open || !enabled) {
      return;
    }

    /**
     * `mousedown`, not `click`, so it fires before the target handles its own press.
     * Focus is NOT returned here: the planner has already moved their attention
     * elsewhere, and yanking it back would fight them.
     */
    const onPointerDown = (event: MouseEvent): void => {
      const target = event.target;
      if (target instanceof Node && areaRef.current?.contains(target) !== true) {
        onClose();
      }
    };

    /**
     * The iframe only sees its OWN document.
     *
     * Clicking Monday's board, its navigation, or anything else around us never reaches
     * the listener above, so the panel would hang open behind the host UI for as long as
     * the view stays mounted. Losing window focus is the one signal we get for "the
     * planner is now interacting with something else".
     */
    const onBlur = (): void => {
      onClose();
    };

    document.addEventListener('mousedown', onPointerDown);
    window.addEventListener('blur', onBlur);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('blur', onBlur);
    };
  }, [open, enabled, onClose]);

  return { areaRef, triggerRef, close };
}
