import { LINKS } from '../config/site';

export function Why() {
  return (
    <section id="why" aria-labelledby="why-title" className="border-t border-border py-16 sm:py-24">
      <div className="container-page">
        <div className="mx-auto max-w-[38rem]">
          <p className="mb-3 text-xs font-medium text-fg-muted">Why Bridge exists</p>
          <h2 id="why-title" className="text-title font-semibold">
            Made for programmers in the same boat
          </h2>
          {/* TODO: Jaypee review. Drafted from your note. Your note named two paid tools;
              the copy says "paid AI coding tools" instead, because Bridge's rules keep other
              products' names out of its copy (CLAUDE.md, rule 6). */}
          <div className="mt-6 flex flex-col gap-4 text-lead text-fg-muted">
            <p className="m-0">
              I built Bridge because I couldn’t afford the paid AI coding tools. What I had was the
              ChatGPT web chat, so I pasted my files in one by one and copied every answer back by
              hand. It worked, but it was slow, and easy to get wrong.
            </p>
            <p className="m-0">
              Bridge does that copying for me, and shows me each change before it lands. It’s for
              programmers in that same boat: students, beginners, anyone who codes on a free plan.
            </p>
          </div>
          <p className="mt-6 mb-0 text-base">
            <a className="link" href={LINKS.author}>
              Jaypee
            </a>
            <span className="text-fg-muted">, who made Bridge</span>
          </p>
        </div>
      </div>
    </section>
  );
}
