import { describe, expect, it } from 'vitest';
import type { TreeEntry } from './files';
import {
  conventionsBlock,
  detectProject,
  packageDependencies,
  UI_BLOCK_MAX_CHARS,
  uiGuidanceBlock
} from './project';
import { buildSessionPrompt } from './prompts';

/** A tree from paths: a trailing `/` makes a folder; parent folders are added. */
function treeOf(...paths: string[]): TreeEntry[] {
  const entries = new Map<string, TreeEntry>();
  for (const raw of paths) {
    const isDir = raw.endsWith('/');
    const path = isDir ? raw.slice(0, -1) : raw;
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i += 1) {
      const dir = parts.slice(0, i).join('/');
      entries.set(dir, { path: dir, type: 'dir', size: 0 });
    }
    entries.set(path, { path, type: isDir ? 'dir' : 'file', size: 100 });
  }
  return [...entries.values()];
}

const pkg = (dependencies: string[], devDependencies: string[] = []) =>
  JSON.stringify({
    dependencies: Object.fromEntries(dependencies.map((d) => [d, '*'])),
    devDependencies: Object.fromEntries(devDependencies.map((d) => [d, '*']))
  });

const viteReact = {
  tree: treeOf(
    'package.json',
    'tsconfig.json',
    'vite.config.ts',
    'index.html',
    'public/favicon.svg',
    'src/main.tsx',
    'src/App.tsx',
    'src/components/Button.tsx',
    'src/components/NavBar.tsx',
    'src/components/UserCard.tsx',
    'src/components/Button.module.css',
    'src/pages/Home.tsx',
    'src/pages/Settings.tsx',
    'src/hooks/use-theme.ts',
    'src/lib/format-date.ts',
    'src/lib/api-client.ts',
    'src/lib/format-date.test.ts'
  ),
  pkg: pkg(['react', 'react-dom'], ['vite', 'typescript', 'vitest', '@vitejs/plugin-react'])
};

const nextApp = {
  tree: treeOf(
    'package.json',
    'tsconfig.json',
    'next.config.mjs',
    'tailwind.config.ts',
    'app/layout.tsx',
    'app/page.tsx',
    'app/blog/[slug]/page.tsx',
    'components/site-header.tsx',
    'components/post-card.tsx',
    'components/ui/button.tsx',
    'lib/posts.ts',
    'public/logo.svg'
  ),
  pkg: pkg(['next', 'react', 'react-dom'], ['typescript', 'tailwindcss'])
};

const expressApi = {
  tree: treeOf(
    'package.json',
    'src/index.js',
    'src/routes/users.js',
    'src/routes/orders.js',
    'src/controllers/userController.js',
    'src/controllers/orderController.js',
    'src/middleware/auth.js',
    'src/models/user.js',
    'tests/users.test.js'
  ),
  pkg: pkg(['express', 'cors'], ['jest'])
};

describe('detectProject', () => {
  it('reads a Vite React TypeScript project', () => {
    const profile = detectProject(viteReact.tree, viteReact.pkg);
    expect(profile).toMatchObject({
      stack: ['Vite', 'React', 'TypeScript'],
      frontend: true,
      isNew: false,
      places: [
        'components in `src/components`',
        'pages in `src/pages`',
        'hooks in `src/hooks`',
        'shared code in `src/lib`',
        'static files in `public/`'
      ],
      naming: ['components in PascalCase `.tsx` (`Button.tsx`)', 'other files in kebab-case'],
      styling: ['CSS modules'],
      tests: 'Vitest, `*.test.ts` next to the code',
      designRules: null
    });
    expect(conventionsBlock(profile)).toBe(
      [
        'PROJECT CONVENTIONS (follow them)',
        '- Stack: Vite + React + TypeScript',
        '- Where things live: components in `src/components`, pages in `src/pages`, hooks in `src/hooks`, shared code in `src/lib`, static files in `public/`',
        '- Naming: components in PascalCase `.tsx` (`Button.tsx`); other files in kebab-case',
        '- Styling: CSS modules',
        '- Tests: Vitest, `*.test.ts` next to the code'
      ].join('\n')
    );
  });

  it('reads a Next.js app', () => {
    const profile = detectProject(nextApp.tree, nextApp.pkg);
    expect(profile).toMatchObject({
      stack: ['Next.js (App Router)', 'TypeScript'],
      frontend: true,
      isNew: false,
      places: [
        'components in `components/`',
        'routes (App Router) in `app/`',
        'shared code in `lib/`',
        'static files in `public/`'
      ],
      naming: ['components in kebab-case `.tsx` (`site-header.tsx`)'],
      styling: ['Tailwind CSS'],
      designRules: 'tailwind.config.ts'
    });
  });

  it('reads an Express API as backend only', () => {
    const profile = detectProject(expressApi.tree, expressApi.pkg);
    expect(profile).toMatchObject({
      stack: ['Express', 'JavaScript'],
      frontend: false,
      isNew: false,
      places: [
        'routes in `src/routes`',
        'controllers in `src/controllers`',
        'middleware in `src/middleware`',
        'models in `src/models`'
      ],
      naming: ['other files in camelCase'],
      styling: [],
      tests: 'Jest, `*.test.js` in `tests/`'
    });
  });

  it('treats an empty folder as new, with the standard layout', () => {
    const profile = detectProject([], null);
    expect(profile).toMatchObject({ stack: [], isNew: true, frontend: false, places: [] });
    expect(conventionsBlock(profile)).toBe(
      [
        'PROJECT CONVENTIONS',
        "This project is new. Use the standard structure from the framework's own docs and templates. For Vite + React: `src/components`, `src/pages`, `src/hooks`, `src/lib`, `src/assets`, `public/`."
      ].join('\n')
    );
  });

  it('gives a new project the layout of the stack its package.json names', () => {
    const fresh = detectProject(treeOf('package.json', 'README.md'), pkg(['next', 'react']));
    expect(fresh.isNew).toBe(true);
    expect(conventionsBlock(fresh)).toContain(
      'For Next.js: `app/`, `components/`, `lib/`, `public/`.'
    );
    const api = detectProject(treeOf('package.json', 'index.js'), pkg(['express']));
    expect(conventionsBlock(api)).toContain('For a Node API: `src/routes`');
  });

  it('reads a broken package.json as none', () => {
    expect(packageDependencies('{ not json')).toEqual(new Set());
    expect(packageDependencies('null')).toEqual(new Set());
  });

  it('counts plain HTML and CSS as frontend', () => {
    const site = detectProject(treeOf('index.html', 'styles.css', 'script.js', 'about.html'));
    expect(site).toMatchObject({ frontend: true, styling: ['plain CSS'] });
  });
});

describe('uiGuidanceBlock', () => {
  const vite = detectProject(viteReact.tree, viteReact.pkg);
  const api = detectProject(expressApi.tree, expressApi.pkg);

  it('gives a frontend project the default rules, under the size limit', () => {
    const block = uiGuidanceBlock(vite, 'auto')!;
    expect(block).toContain('UI QUALITY');
    expect(block).toContain('10. Match a well-designed product, not a tutorial demo.');
    expect(block).toContain('No generic AI look');
    expect(block.length).toBeLessThanOrEqual(UI_BLOCK_MAX_CHARS);
  });

  it('leaves it out for a backend-only project, unless set to Always', () => {
    expect(uiGuidanceBlock(api, 'auto')).toBeNull();
    expect(uiGuidanceBlock(api, 'always')).toContain('UI QUALITY');
  });

  it('points at DESIGN.md instead of the defaults when the project has one', () => {
    const withDesign = detectProject(
      [...viteReact.tree, { path: 'DESIGN.md', type: 'file', size: 4000 }],
      viteReact.pkg
    );
    expect(withDesign.designRules).toBe('DESIGN.md');
    const block = uiGuidanceBlock(withDesign, 'auto')!;
    expect(block).toContain('own design rules in `DESIGN.md`');
    expect(block).toContain('`@@READ DESIGN.md@@`');
    expect(block).not.toContain('No generic AI look');
    expect(block.length).toBeLessThanOrEqual(UI_BLOCK_MAX_CHARS);
  });

  it('finds design rules in docs/ and token files, a doc first', () => {
    const tokens = detectProject(
      treeOf('src/styles/tokens.css', 'src/App.tsx', 'src/main.tsx', 'src/x.tsx'),
      pkg(['react'])
    );
    expect(tokens.designRules).toBe('src/styles/tokens.css');
    expect(uiGuidanceBlock(tokens, 'auto')).toContain('follow its tokens');
    const both = detectProject(
      treeOf('docs/design-system.md', 'src/styles/tokens.css', 'src/App.tsx'),
      pkg(['react'])
    );
    expect(both.designRules).toBe('docs/design-system.md');
  });

  it('is removed by Off', () => {
    expect(uiGuidanceBlock(vite, 'off')).toBeNull();
  });
});

describe('buildSessionPrompt with a project profile', () => {
  const vite = detectProject(viteReact.tree, viteReact.pkg);
  const api = detectProject(expressApi.tree, expressApi.pkg);
  const prompt = (profile = vite, uiGuidance: 'auto' | 'always' | 'off' = 'auto') =>
    buildSessionPrompt({ projectName: 'demo', tree: viteReact.tree, profile, uiGuidance });

  it('puts rule 9, the conventions and the UI block before the tree', () => {
    const text = prompt();
    expect(text).toContain(
      "9. Follow the project's existing structure and naming. If the project is new, use the standard structure for its framework. Don't reorganise existing files unless I ask."
    );
    const order = ['RULES', 'PROJECT CONVENTIONS', 'UI QUALITY', 'PROJECT FILES'].map((s) =>
      text.indexOf(s)
    );
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order.every((at) => at >= 0)).toBe(true);
  });

  it('leaves the UI block out for a backend project and when Off', () => {
    expect(prompt(api)).not.toContain('UI QUALITY');
    expect(prompt(api)).toContain('PROJECT CONVENTIONS');
    expect(prompt(vite, 'off')).not.toContain('UI QUALITY');
  });
});
