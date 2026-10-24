import type { TreeEntry } from './files';

// What the session prompt says about the project itself: its stack and conventions (so the
// chat follows them, or the framework's standard layout in a new project) and, for UI work,
// either the project's own design rules or a short default. Built from the tree and
// `package.json`'s dependency names only; no file contents go into the chat from here.

/** Settings → Project → UI guidance. Auto: frontend projects only, their own rules first. */
export const UI_GUIDANCE = ['auto', 'always', 'off'] as const;
export type UiGuidance = (typeof UI_GUIDANCE)[number];

export const UI_GUIDANCE_LABELS: Record<UiGuidance, string> = {
  auto: 'Auto',
  always: 'Always',
  off: 'Off'
};

/** The longest the UI block may be, so the session prompt stays short. */
export const UI_BLOCK_MAX_CHARS = 900;

export interface ProjectProfile {
  /** e.g. ["Vite", "React", "TypeScript"]. Empty when nothing is recognised. */
  stack: string[];
  /** Has a UI: a frontend framework, or HTML/CSS without a backend framework. */
  frontend: boolean;
  /** Next to nothing in it yet: use the framework's standard layout. */
  isNew: boolean;
  /** "components in `src/components`", in a fixed order. */
  places: string[];
  /** "components in PascalCase `.tsx` (`Button.tsx`)", "other files in kebab-case". */
  naming: string[];
  /** "Tailwind CSS", "CSS modules", "plain CSS". */
  styling: string[];
  /** "Vitest, `*.test.ts` next to the code". */
  tests: string | null;
  /** The project's own design rules, if it has any: a doc, a tokens file or a Tailwind config. */
  designRules: string | null;
}

/** The dependency names in a `package.json`, or an empty set if it can't be read. */
export function packageDependencies(text: string | null): Set<string> {
  const names = new Set<string>();
  if (!text) return names;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null) return names;
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
      const deps = (parsed as Record<string, unknown>)[field];
      if (typeof deps === 'object' && deps !== null) for (const name in deps) names.add(name);
    }
  } catch {
    // Not JSON: as if there were no package.json.
  }
  return names;
}

const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const extOf = (path: string) => {
  const name = baseName(path);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
};
const stemOf = (path: string) => {
  const name = baseName(path);
  const dot = name.indexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
};

const CODE_EXTENSIONS = new Set([
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'vue',
  'svelte',
  'astro',
  'html',
  'css',
  'scss',
  'py',
  'go',
  'rs',
  'rb',
  'php',
  'java',
  'kt',
  'swift'
]);
/** Files a starter project has before any real code: they don't make it "existing". */
const SCAFFOLD_FILES =
  /^(?:vite|next|nuxt|astro|svelte|tailwind|postcss|eslint|prettier|vitest|jest|babel|webpack|tsup|rollup)\.config\.\w+$|^\.?(?:eslintrc|prettierrc)/i;

/** Frontend frameworks by dependency, most specific first. */
const FRAMEWORKS: [dep: string, name: string][] = [
  ['next', 'Next.js'],
  ['nuxt', 'Nuxt'],
  ['@sveltejs/kit', 'SvelteKit'],
  ['astro', 'Astro'],
  ['@angular/core', 'Angular'],
  ['@remix-run/react', 'Remix']
];
/** UI libraries, named after Vite (or alone) when no framework above is there. */
const UI_LIBRARIES: [dep: string, name: string][] = [
  ['react', 'React'],
  ['vue', 'Vue'],
  ['svelte', 'Svelte'],
  ['solid-js', 'Solid'],
  ['preact', 'Preact']
];
const BACKENDS: [dep: string, name: string][] = [
  ['@nestjs/core', 'NestJS'],
  ['express', 'Express'],
  ['fastify', 'Fastify'],
  ['koa', 'Koa'],
  ['hono', 'Hono']
];
const TEST_RUNNERS: [dep: string, name: string][] = [
  ['vitest', 'Vitest'],
  ['jest', 'Jest'],
  ['mocha', 'Mocha'],
  ['@playwright/test', 'Playwright']
];

/** Folders with a known purpose, in the order the prompt lists them. */
const PLACES: [dir: string, what: string][] = [
  ['src/components', 'components'],
  ['components', 'components'],
  ['src/app', 'routes (App Router)'],
  ['app', 'routes (App Router)'],
  ['src/pages', 'pages'],
  ['pages', 'pages'],
  ['src/routes', 'routes'],
  ['routes', 'routes'],
  ['src/views', 'views'],
  ['src/layouts', 'layouts'],
  ['src/hooks', 'hooks'],
  ['src/composables', 'composables'],
  ['src/lib', 'shared code'],
  ['lib', 'shared code'],
  ['src/utils', 'utilities'],
  ['src/controllers', 'controllers'],
  ['controllers', 'controllers'],
  ['src/services', 'services'],
  ['src/middleware', 'middleware'],
  ['src/models', 'models'],
  ['src/stores', 'state'],
  ['src/store', 'state'],
  ['src/styles', 'styles'],
  ['src/assets', 'assets'],
  ['public', 'static files'],
  ['static', 'static files']
];
const MAX_PLACES = 8;

/** Design rule files, by name (any case), at the root or in `docs/`. */
const DESIGN_DOCS = ['design.md', 'design-system.md', 'styleguide.md', 'style-guide.md'];
const TOKEN_FILES =
  /^(?:tokens|design-tokens|theme|variables)\.(?:css|scss)$|^design-tokens\.json$/i;
const TAILWIND_CONFIG = /^tailwind\.config\.(?:js|cjs|mjs|ts|cts|mts)$/;

/** The standard layout for a new project of each stack, from the framework's own templates. */
const STANDARD_LAYOUTS: [test: (stack: string[]) => boolean, label: string, dirs: string][] = [
  [(s) => s.includes('Next.js'), 'Next.js', '`app/`, `components/`, `lib/`, `public/`'],
  [
    (s) => s.includes('Nuxt'),
    'Nuxt',
    '`pages/`, `components/`, `composables/`, `layouts/`, `public/`'
  ],
  [
    (s) => s.includes('SvelteKit'),
    'SvelteKit',
    '`src/routes`, `src/lib`, `src/lib/components`, `static/`'
  ],
  [(s) => s.includes('Astro'), 'Astro', '`src/pages`, `src/components`, `src/layouts`, `public/`'],
  [
    (s) => s.includes('Vue'),
    'Vite + Vue',
    '`src/components`, `src/views`, `src/composables`, `src/assets`, `public/`'
  ],
  [
    (s) => s.some((name) => ['Express', 'Fastify', 'Koa', 'Hono'].includes(name)),
    'a Node API',
    '`src/routes`, `src/controllers`, `src/services`, `src/middleware`'
  ],
  [
    () => true,
    'Vite + React',
    '`src/components`, `src/pages`, `src/hooks`, `src/lib`, `src/assets`, `public/`'
  ]
];

/** The share of `values` that pass, if there are enough of them to tell. */
function mostly(values: readonly string[], test: (value: string) => boolean): boolean {
  return values.length >= 2 && values.filter(test).length / values.length >= 0.6;
}

const PASCAL = /^[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)*$/;
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)+$/;
const CAMEL = /^[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)+$/;

function namingOf(files: readonly string[]): string[] {
  const out: string[] = [];
  const named = (path: string) =>
    !['index', 'main', 'app', 'page', 'layout'].includes(stemOf(path).toLowerCase());
  const components = files.filter(
    (path) =>
      /(?:^|\/)components\//.test(path) &&
      ['tsx', 'jsx', 'vue', 'svelte', 'astro'].includes(extOf(path))
  );
  const stems = components.filter(named).map(stemOf);
  if (stems.length > 0) {
    const style = mostly(stems, (s) => PASCAL.test(s))
      ? 'PascalCase'
      : mostly(stems, (s) => KEBAB.test(s))
        ? 'kebab-case'
        : null;
    const exts = components.map(extOf);
    const ext = ['tsx', 'jsx', 'vue', 'svelte', 'astro'].find((e) => mostly(exts, (x) => x === e));
    const example = components.find((path) => named(path) && (!ext || extOf(path) === ext));
    if (style || ext) {
      out.push(
        `components in ${[style, ext && `\`.${ext}\``].filter(Boolean).join(' ')}${example ? ` (\`${baseName(example)}\`)` : ''}`
      );
    }
  }
  const others = files
    .filter(
      (path) => !components.includes(path) && ['ts', 'js', 'mjs', 'cjs'].includes(extOf(path))
    )
    .map(stemOf)
    .filter((stem) => stem.includes('-') || /[A-Z]/.test(stem));
  if (mostly(others, (s) => KEBAB.test(s))) out.push('other files in kebab-case');
  else if (mostly(others, (s) => CAMEL.test(s))) out.push('other files in camelCase');
  return out;
}

/** What the project is and how it's laid out, from its tree and `package.json`. */
export function detectProject(
  tree: readonly TreeEntry[],
  packageJson: string | null = null
): ProjectProfile {
  const deps = packageDependencies(packageJson);
  const dirs = new Set(tree.filter((e) => e.type === 'dir').map((e) => e.path));
  const files = tree.filter((e) => e.type === 'file' && !e.collapsed).map((e) => e.path);
  const names = new Set(files.map((path) => baseName(path)));
  const has = (dep: string) => deps.has(dep);
  const exts = new Set(files.map(extOf));

  const stack: string[] = [];
  const framework = FRAMEWORKS.find(([dep]) => has(dep));
  if (framework) {
    if (framework[1] === 'Next.js') {
      stack.push(
        dirs.has('app') || dirs.has('src/app')
          ? 'Next.js (App Router)'
          : dirs.has('pages') || dirs.has('src/pages')
            ? 'Next.js (Pages Router)'
            : 'Next.js'
      );
    } else stack.push(framework[1]);
  } else {
    if (has('vite')) stack.push('Vite');
    const ui = UI_LIBRARIES.find(([dep]) => has(dep));
    if (ui) stack.push(ui[1]);
  }
  const backend = BACKENDS.find(([dep]) => has(dep));
  if (backend) stack.push(backend[1]);
  const typescript =
    has('typescript') || names.has('tsconfig.json') || exts.has('ts') || exts.has('tsx');
  if (typescript) stack.push('TypeScript');
  else if (packageJson !== null || exts.has('js') || exts.has('jsx')) stack.push('JavaScript');
  if (names.has('pyproject.toml') || names.has('requirements.txt') || exts.has('py'))
    stack.push('Python');
  if (names.has('go.mod')) stack.push('Go');
  if (names.has('Cargo.toml')) stack.push('Rust');

  const frontendFramework =
    framework !== undefined || UI_LIBRARIES.some(([dep]) => has(dep)) || has('vite');
  const frontend =
    frontendFramework ||
    (!backend &&
      (exts.has('html') ||
        exts.has('css') ||
        exts.has('scss') ||
        exts.has('vue') ||
        exts.has('svelte')));

  const code = files.filter(
    (path) => CODE_EXTENSIONS.has(extOf(path)) && !SCAFFOLD_FILES.test(baseName(path))
  );
  const isNew = code.length <= 2;

  const nextApp = stack.some((name) => name.startsWith('Next.js'));
  const places: string[] = [];
  const seen = new Set<string>();
  for (const [dir, what] of PLACES) {
    if (!dirs.has(dir) || places.length >= MAX_PLACES) continue;
    if (what === 'routes (App Router)' && !nextApp) continue;
    // `components/` after `src/components/`: one line per purpose.
    if (seen.has(what)) continue;
    seen.add(what);
    places.push(`${what} in \`${dir}${dir.includes('/') ? '' : '/'}\``);
  }

  const styling: string[] = [];
  if (has('tailwindcss') || files.some((path) => TAILWIND_CONFIG.test(baseName(path))))
    styling.push('Tailwind CSS');
  if (files.some((path) => /\.module\.(?:css|scss|sass)$/.test(path))) styling.push('CSS modules');
  if (has('styled-components')) styling.push('styled-components');
  if (has('@emotion/react') || has('@emotion/styled')) styling.push('Emotion');
  if (has('sass') || exts.has('scss')) styling.push('Sass');
  if (styling.length === 0 && exts.has('css')) styling.push('plain CSS');

  const runner = TEST_RUNNERS.find(([dep]) => has(dep))?.[1];
  const testFiles = files.filter((path) => /\.(?:test|spec)\.[jt]sx?$/.test(path));
  const inFolder = testFiles.filter((path) => /(?:^|\/)(?:tests?|__tests__)\//.test(path));
  const sample = testFiles[0]
    ? `\`*.${baseName(testFiles[0]).split('.').slice(-2).join('.')}\``
    : null;
  const where =
    testFiles.length === 0
      ? null
      : inFolder.length > testFiles.length / 2
        ? `${sample} in \`${inFolder[0]!.split('/').slice(0, -1).join('/')}/\``
        : `${sample} next to the code`;
  const tests = runner || where ? [runner, where].filter(Boolean).join(', ') : null;

  const designDoc = files.find((path) => {
    const parts = path.split('/');
    return (
      (parts.length === 1 || (parts.length === 2 && parts[0]!.toLowerCase() === 'docs')) &&
      DESIGN_DOCS.includes(baseName(path).toLowerCase())
    );
  });
  const tokens = files.find((path) => TOKEN_FILES.test(baseName(path)));
  const tailwind = files.find((path) => !path.includes('/') && TAILWIND_CONFIG.test(path));

  return {
    stack,
    frontend,
    isNew,
    places,
    naming: namingOf(files),
    styling,
    tests,
    designRules: designDoc ?? tokens ?? tailwind ?? null
  };
}

/**
 * "PROJECT CONVENTIONS": the stack, where things live, naming, styling and tests, for the
 * chat to follow. For a new project, the standard layout for its stack instead.
 */
export function conventionsBlock(profile: ProjectProfile): string | null {
  const stack = profile.stack.join(' + ');
  if (profile.isNew) {
    const [, label, dirs] = STANDARD_LAYOUTS.find(([test]) => test(profile.stack))!;
    return [
      'PROJECT CONVENTIONS',
      `This project is new${stack ? ` (${stack})` : ''}. Use the standard structure from the framework's own docs and templates. For ${label}: ${dirs}.`
    ].join('\n');
  }
  const lines = [
    stack && `- Stack: ${stack}`,
    profile.places.length > 0 && `- Where things live: ${profile.places.join(', ')}`,
    profile.naming.length > 0 && `- Naming: ${profile.naming.join('; ')}`,
    profile.styling.length > 0 && `- Styling: ${profile.styling.join(', ')}`,
    profile.tests && `- Tests: ${profile.tests}`
  ].filter((line): line is string => typeof line === 'string' && line.length > 0);
  if (lines.length === 0) return null;
  return ['PROJECT CONVENTIONS (follow them)', ...lines].join('\n');
}

/** The default UI rules, for projects without their own. */
export const DEFAULT_UI_RULES = [
  "1. Reuse the project's components, tokens and styles before making new ones.",
  '2. One spacing scale; a clear type hierarchy: one strong heading size per section, readable body text.',
  '3. A small palette: neutrals plus one accent, used sparingly.',
  '4. WCAG AA contrast, visible focus states, labels on inputs, alt text on images.',
  '5. Responsive and mobile-first, with no horizontal scroll.',
  '6. Design every state: hover, focus, active, disabled, loading, empty, error.',
  '7. Real, specific copy: no lorem ipsum, no "Welcome to our amazing app".',
  '8. No generic AI look: no gradient blobs, glowing orbs, pill badges everywhere, emoji as icons, or everything centred in identical cards.',
  '9. Subtle, purposeful motion (transform and opacity only); respect prefers-reduced-motion.',
  '10. Match a well-designed product, not a tutorial demo.'
];

/**
 * "UI QUALITY", or null: in Auto only for frontend projects, Always for any, never when
 * Off. A project with its own design rules is told to read and follow them instead of the
 * defaults.
 */
export function uiGuidanceBlock(profile: ProjectProfile, setting: UiGuidance): string | null {
  if (setting === 'off' || (setting === 'auto' && !profile.frontend)) return null;
  if (profile.designRules) {
    const path = profile.designRules;
    const what = TAILWIND_CONFIG.test(baseName(path))
      ? 'its theme'
      : TOKEN_FILES.test(baseName(path))
        ? 'its tokens'
        : 'it';
    return [
      'UI QUALITY (when you build or change UI)',
      `This project has its own design rules in \`${path}\`. Before UI work, send \`@@READ ${path}@@\` unless I've already sent it, then follow ${what} over any general taste. Reuse the existing components and styles.`
    ].join('\n');
  }
  return ['UI QUALITY (when you build or change UI)', ...DEFAULT_UI_RULES].join('\n');
}
