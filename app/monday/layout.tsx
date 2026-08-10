/**
 * Transparent canvas for everything served into a Monday iframe.
 *
 * The root layout paints `body { bg-background }`, which is WHITE outside
 * `.monday-surface`. In a dark workspace that gives a white flash on every open: the
 * browser paints the iframe, then our page paints white again while `monday.get('context')`
 * is still in flight, and only then does the real theme arrive.
 *
 * There is no way to know the theme before that round trip — so the answer is to paint
 * nothing. A transparent iframe shows Monday's own backdrop, which is already the right
 * colour in either theme, and the view fades in over it instead of over white.
 */
export default function MondayLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <style>{`html, body { background: transparent !important; }`}</style>
      {children}
    </>
  );
}
