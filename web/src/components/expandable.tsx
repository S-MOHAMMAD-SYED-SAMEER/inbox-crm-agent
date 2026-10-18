import { useState, type ReactNode } from 'react';

// Text that was cut for the list and is available in full with one click.
//
// A cut with no way to read the rest is a loss; a cut with one is a layout choice. The shown text already ends at a whole word
// with an ellipsis (see `cutAtWord`), so this only has to offer the rest.

export function ExpandableText({
  shown,
  full,
  className = '',
}: {
  /** What is visible by default, already cut at a whole word. */
  shown: string;
  /** The whole text. When it is absent or equal to `shown` there is nothing to expand. */
  full?: string | undefined;
  className?: string;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const expandable = full !== undefined && full !== shown && full.length > shown.replace(/…$/, '').length;

  return (
    <span className={className}>
      {open && expandable ? full : shown}
      {expandable ? (
        <>
          {' '}
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
            className="text-brand underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
          >
            {open ? 'Show less' : 'Show more'}
          </button>
        </>
      ) : null}
    </span>
  );
}
