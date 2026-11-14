/**
 * Portal-aware event containment.
 *
 * React propagates through the REACT tree, not the DOM tree. Every floating
 * surface in this app — popovers, dialogs, dropdowns, context menus, floating
 * windows, selects — is PORTALLED to `document.body`, yet its events still
 * travel through whichever component rendered it. So a big region that installs
 * a CAPTURE-phase handler (the stage, the layer list, the timeline lanes) sees
 * every event that happens on a panel floating two layers above it, and gets to
 * act on it FIRST.
 *
 * That is one bug wearing three faces:
 *   • right-clicking inside the fill picker opened the STAGE's layer menu, and
 *     the new menu layer dismissed the picker on its way in;
 *   • the stage's "not the canvas ⇒ swallow it" branch stopped propagation
 *     during capture, so a popover's own context menu never got the event;
 *   • the layers/timeline handlers re-targeted the SELECTION from a click that
 *     never touched a row.
 *
 * The honest question is "did this event happen inside my DOM?", and it has one
 * answer. Ask it here rather than tagging every floating surface with a data
 * attribute — a tag has to be remembered by every panel written from now on,
 * and DOM containment is already true of all of them.
 */
export function isForeignEvent(
  container: Element | null | undefined,
  e: { target: EventTarget | null },
): boolean {
  const target = e.target as Node | null;
  if (!container || !target) return false;
  return !container.contains(target);
}

/**
 * What EVERY floating surface spreads onto its content — the component-level
 * half of the containment, and the half that actually holds.
 *
 * Bubbling is the direction that matters here. A right-click inside a portalled
 * panel travels back UP the React tree and reaches the bubble-phase handlers of
 * whatever rendered it — including a Radix `ContextMenuTrigger` wrapping the
 * whole stage, which then opens a menu, and that new layer dismisses the panel
 * on its way in. Stopping the event at the panel's own root ends that for every
 * ancestor, present and future, without any of them knowing this exists.
 *
 * An earlier attempt tried to disarm the ancestor's trigger by preventing the
 * default in a sibling handler. It cannot work: Radix's `Slot` composes an
 * asChild child's handler with its own as `child(...); slot(...)`, with no
 * defaultPrevented check between them, so the trigger fired regardless. The
 * lesson is the general one — a fix that depends on another component's
 * internal composition order is not a fix.
 *
 * Handlers INSIDE the panel are unaffected: they are descendants, so they have
 * already run by the time the event reaches this root. That is what lets a
 * gradient stop keep its own context menu inside a picker that swallows the
 * event for everyone above it.
 */
/**
 * Spread onto a floating surface's content, composed with whatever the call
 * site already passed so a surface that needs its own handler never has to
 * choose between the two.
 */
export function withFloatingLayerEvents<E extends Element>(props: {
  onContextMenu?: React.MouseEventHandler<E>;
  onPointerDown?: React.PointerEventHandler<E>;
}): { onContextMenu: React.MouseEventHandler<E>; onPointerDown: React.PointerEventHandler<E> } {
  return {
    onContextMenu: (e) => {
      e.stopPropagation();
      // …and no BROWSER menu either. Stopping propagation keeps the event away
      // from ancestors, but a right-click that nothing inside the panel claimed
      // still fell through to the browser's own menu — so a panel full of
      // working menus read as "right-click does nothing here", because the
      // places people try first (the chrome, a swatch, a label, the background)
      // are exactly the inert ones.
      //
      // `defaultPrevented` is the test for "claimed": a Radix trigger inside
      // the panel is a DESCENDANT, so it has already run and already prevented
      // the default by the time the event reaches this root. Wired controls are
      // therefore untouched, and everything else goes quiet. Doing it here
      // rather than on each inert element is the only version that stays true —
      // the next control added to any floating surface cannot forget to.
      if (!e.defaultPrevented) e.preventDefault();
      props.onContextMenu?.(e);
    },
    onPointerDown: (e) => {
      e.stopPropagation();
      props.onPointerDown?.(e);
    },
  };
}
