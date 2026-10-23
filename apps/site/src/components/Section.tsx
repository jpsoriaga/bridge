import type { ReactNode } from 'react';

/** A page section: a small muted label (as the apps' section labels), a heading, an intro. */
export function Section({
  id,
  label,
  title,
  intro,
  children,
  className = ''
}: {
  id: string;
  label: string;
  title: string;
  intro?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-title`}
      className={`border-t border-border py-16 sm:py-24 ${className}`}
    >
      <div className="container-page">
        <div className="max-w-[40rem]">
          <p className="mb-3 text-xs font-medium text-fg-muted">{label}</p>
          <h2 id={`${id}-title`} className="text-title font-semibold text-fg">
            {title}
          </h2>
          {intro ? <div className="mt-4 text-lead text-fg-muted">{intro}</div> : null}
        </div>
        <div className="mt-10 sm:mt-12">{children}</div>
      </div>
    </section>
  );
}
