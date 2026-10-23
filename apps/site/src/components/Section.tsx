import type { ReactNode } from 'react';

/**
 * A page section: a heading, an optional intro, then its content. `split` puts the heading
 * in a left column on wide screens (Safety, FAQ); `panel` sets the section in a muted panel
 * that breaks out wider than the column (Download).
 */
export function Section({
  id,
  title,
  intro,
  children,
  layout = 'stacked'
}: {
  id: string;
  title: string;
  intro?: ReactNode;
  children: ReactNode;
  layout?: 'stacked' | 'split' | 'panel';
}) {
  const header = (
    <div className={layout === 'split' ? 'lg:sticky lg:top-28' : 'max-w-[42rem]'} data-reveal="">
      <h2 id={`${id}-title`} className="m-0 text-title font-semibold text-balance text-fg">
        {title}
      </h2>
      {intro ? <div className="mt-5 text-lead text-pretty text-fg-muted">{intro}</div> : null}
    </div>
  );

  if (layout === 'panel') {
    return (
      <section id={id} aria-labelledby={`${id}-title`} className="py-12 sm:py-16">
        <div className="container-wide">
          <div className="rounded-2xl border border-border bg-bg-muted px-5 py-12 sm:px-10 sm:py-16 lg:px-16 lg:py-20">
            <div className="mx-auto max-w-[1120px]">
              {header}
              <div className="mt-10 sm:mt-12">{children}</div>
            </div>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section id={id} aria-labelledby={`${id}-title`} className="py-20 sm:py-28 lg:py-32">
      <div
        className={`container-page ${
          layout === 'split'
            ? 'grid items-start gap-10 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] lg:gap-20'
            : ''
        }`}
      >
        {header}
        <div className={layout === 'split' ? 'min-w-0' : 'mt-12 sm:mt-16'}>{children}</div>
      </div>
    </section>
  );
}
