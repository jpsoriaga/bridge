import { LINKS } from '../config/site';

export function Why() {
  return (
    <section id="why" aria-labelledby="why-title" className="py-20 sm:py-28 lg:py-32">
      <div className="container-page">
        <div className="max-w-[52rem]" data-reveal="">
          <h2 id="why-title" className="m-0 text-title font-semibold text-balance">
            Made for programmers in the same boat
          </h2>
          {/* TODO: Jaypee review. Drafted from your note. Your note named two paid tools;
              the copy says "paid AI coding tools" instead, because Bridge's rules keep other
              products' names out of its copy (CLAUDE.md, rule 6). */}
          <figure className="m-0 mt-10 sm:mt-14">
            <blockquote className="m-0 border-l border-fg pl-6 sm:pl-10">
              <p className="m-0 text-quote font-medium text-pretty text-fg">
                I built Bridge because I couldn’t afford the paid AI coding tools. What I had was
                the ChatGPT web chat, so I pasted my files in one by one and copied every answer
                back by hand. It worked, but it was slow, and easy to get wrong.
              </p>
              <p className="mt-6 mb-0 max-w-[40rem] text-lead text-pretty text-fg-muted">
                Bridge does that copying for me, and shows me each change before it lands. It’s for
                programmers in that same boat: students, beginners, anyone who codes on a free plan.
              </p>
            </blockquote>
            <figcaption className="mt-8 pl-6 text-base sm:pl-10">
              <a className="link" href={LINKS.author}>
                Jaypee
              </a>
              <span className="text-fg-muted">, who made Bridge</span>
            </figcaption>
          </figure>
        </div>
      </div>
    </section>
  );
}
