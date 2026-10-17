# Bridge design system

Clean, neutral, black on white. The chat is the work, and Bridge's UI should feel like part of it rather than a layer on top. The reference is the mockup with a chat column on the left (assistant text, diff cards, command card, composer) and the Bridge side panel on the right (project, mode, actions, files, activity, Stop).

Tokens and base components live in [`packages/shared/src/styles.css`](packages/shared/src/styles.css). Both apps import it as `@bridge/shared/styles.css`. If this file and the CSS disagree, fix whichever is wrong in the same change.

## Principles

- **Neutral first.** Surfaces are white (or near-black in dark mode), text is ink, and borders are hairlines. The only colours are the semantic ones below.
- **Colour means state.** Green means added or applied, red means removed or destructive, orange means waiting on you, and grey means idle. Nothing is coloured for decoration.
- **Hairlines, not shadows.** Separate things with 1px borders and space. Only two places get a shadow (see Elevation).
- **One primary action per view.** It's the black button. Everything else is secondary.
- **Sentence case** everywhere: "Start session", not "Start Session".

## Where the image and the black/white direction conflict

The image wins on each point below. Each deviation is deliberate and scoped:

| Topic            | Minimalist default   | Image                                                       | Rule we follow                                                       |
| ---------------- | -------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------- |
| Colour           | Black and white only | Green, red and orange for diff lines, counts, dots and Stop | Allowed, but **only** as semantic state tokens. Never decorative     |
| Diff backgrounds | None                 | Tinted green/red line backgrounds                           | Use `--success-bg` / `--danger-bg` on diff rows only                 |
| Shadow           | None                 | Faint shadow on the composer and the active mode segment    | `--shadow-xs` on exactly those two                                   |
| Corners          | Square               | Rounded cards (12px), buttons (8px), pill composer          | Use the radius scale below                                           |
| Stop button      | Neutral              | Red text and red-tinted border                              | `.btn-danger`, used only for Stop and destructive actions            |
| Dark mode        | Not shown            | Not shown                                                   | Supported. Tokens invert; semantic colours shift lighter (see table) |

## Layout

### Window

```
┌──────────────────────────────────────────────┬───────────────────────┐
│ Chat  Sol · High                    (56px)   │ [■] Bridge  ● Connected│
├──────────────────────────────────────────────┼───────────────────────┤
│        ┌────────────────────────────┐        │ Project               │
│        │ chat column, max 760px     │        │ Mode  [segmented]     │
│        │ messages, diff cards,      │        │ [Start session][Send] │
│        │ command card               │        │ Files in context      │
│        └────────────────────────────┘        │ Activity              │
│        ( composer pill )                     ├───────────────────────┤
│                                              │ Step 3 of 10    [Stop]│
└──────────────────────────────────────────────┴───────────────────────┘
```

- **Top bars** are 56px tall with a hairline below. The chat bar shows the title (16px, 600) and a muted model line (13px). The panel bar shows the logo (24px) with "Bridge" (16px, 600) on the left and the status pill on the right.
- **Chat column**: content is centred, max width 760px, with 32px top padding. Gaps are 16px between blocks and 12px between a message and its card.
- **Side panel**: about 340px wide with a hairline on its left edge. Sections are stacked with 20px horizontal padding and 24px between sections. Each section is a muted label (12px) with its content below.
- **Panel footer**: a hairline on top, 16px/20px padding, the step counter (12px, muted) on the left and Stop on the right. It sticks to the bottom.
- **Desktop app**: the same top bar, then a single centred 480px column with the panel's sections (Project, Extension, Mode, Activity, Settings), and a footer showing the version. The top bar and footer stay put while the column scrolls. With a project open, the top bar shows the project name (13px, 600) and its path (mono 12px, `--fg-muted`, truncated) between the brand and the status pill.

### Chat elements

- **User message**: right-aligned bubble, `--bg-muted`, radius 18px, padding 10px 16px, 14px text.
- **Assistant text**: 14px/1.5 on the page background. Inline code is Geist Mono 13px on `--bg-muted` with a 6px radius and 1px 5px padding.
- **Composer**: a full pill, 48px tall, with a 1px `--border` and `--shadow-xs`. Placeholder text is `--fg-subtle`. The send button is a 32px circle in `--inverse-bg` with an up-arrow icon.

## Color tokens

| Token             | Light     | Dark                  | Use                                                           |
| ----------------- | --------- | --------------------- | ------------------------------------------------------------- |
| `--bg`            | `#ffffff` | `#0d0d0d`             | Page, cards, secondary buttons                                |
| `--bg-muted`      | `#f3f3f3` | `#1c1c1c`             | User bubble, inline code, segmented track                     |
| `--bg-hover`      | `#f7f7f7` | `#161616`             | Button hover, diff-card footer                                |
| `--bg-raised`     | `#ffffff` | `#2e2e2e`             | Active mode segment (sits above the track)                    |
| `--fg`            | `#111111` | `#ededed`             | Primary text, file paths                                      |
| `--fg-muted`      | `#5c5c5c` | `#a3a3a3`             | Labels, meta ("New file · +18"), hints                        |
| `--fg-subtle`     | `#8f8f8f` | `#6b6b6b`             | Placeholders, version, disabled text                          |
| `--border`        | `#e5e5e5` | `#262626`             | Hairlines, card and button edges                              |
| `--border-strong` | `#d4d4d4` | `#3a3a3a`             | Pending diff card, dashed command card, hovered button        |
| `--inverse-bg`    | `#111111` | `#ededed`             | Primary button, send button, logo tile                        |
| `--inverse-fg`    | `#ffffff` | `#0d0d0d`             | Text and icons on `--inverse-bg`                              |
| `--success`       | `#1a7f37` | `#3fb950`             | "Applied", `+N`, "new" tag, applied/connected dot, check icon |
| `--success-bg`    | `#e8f6ec` | `rgb(63 185 80/.12)`  | Added diff lines                                              |
| `--danger`        | `#c4261d` | `#f2655c`             | `−N`, Stop, destructive buttons                               |
| `--danger-bg`     | `#fdeceb` | `rgb(242 101 92/.12)` | Removed diff lines, danger button hover                       |
| `--warning`       | `#c2570c` | `#e8853d`             | "Waiting for review" dot                                      |
| `--idle`          | `#a3a3a3` | `#6b6b6b`             | Neutral activity dot, "Not connected"                         |

Dark mode follows `prefers-color-scheme`. Components use only tokens and never raw hex values.

## Typography

| Family     | Package                           | Used for                                                      |
| ---------- | --------------------------------- | ------------------------------------------------------------- |
| Geist      | `@fontsource-variable/geist`      | All UI text                                                   |
| Geist Mono | `@fontsource-variable/geist-mono` | File paths, diff bodies, commands, inline code, the file tree |

| Role                  | Size | Weight  | Notes                                  |
| --------------------- | ---- | ------- | -------------------------------------- |
| Bar title / wordmark  | 16px | 600     | `letter-spacing: -0.01em`              |
| Body, chat text       | 14px | 400     | line-height 1.5                        |
| Button                | 13px | 500     | Primary button 600                     |
| Mode segment          | 13px | 500     | Active 600                             |
| Path, diff, command   | 13px | 400     | Geist Mono, diff line-height 21px      |
| Label, meta, hint     | 12px | 400     | `--fg-muted`                           |
| Status pill, counters | 12px | 400–500 |                                        |
| Pairing code          | 24px | 600     | Geist Mono, tabular, `0.08em` tracking |

Tokens: `--text-xs` 12, `--text-sm` 13, `--text-base` 14, `--text-lg` 16, `--text-xl` 24 (pairing code only).

## Spacing, radii, borders, elevation

- **Spacing** is on a 4px base: `--space-1` 4, `-2` 8, `-3` 12, `-4` 16, `-5` 20, `-6` 24, `-8` 32.
- **Radii**: `--radius-sm` 6px (inline code, tags), `--radius-md` 8px (buttons, segments), `--radius-lg` 12px (cards, segmented track), `--radius-xl` 18px (chat bubble), `--radius-full` (composer, dots, send button).
- **Borders** are always 1px. Use solid `--border` by default and `--border-strong` for pending or emphasised items. The command card is **dashed** `--border-strong`, the only dashed line in the system.
- **Elevation**: `--shadow-xs` (`0 1px 2px rgb(0 0 0/.06)`) appears only on the composer and the active mode segment. There are no other shadows, gradients or blur.
- **Focus**: a 2px ring in `--fg`, offset 2px (`--focus-ring`), shown on `:focus-visible` only.
- **Motion**: 120ms colour and background transitions with `--ease`. Nothing slides or bounces, and all of it is off under `prefers-reduced-motion`.

## Components

### Button (`.btn`)

| Variant                | Rest                                          | Hover                                  | Disabled    |
| ---------------------- | --------------------------------------------- | -------------------------------------- | ----------- |
| Secondary (default)    | `--bg`, 1px `--border`, `--fg`                | `--bg-hover`, `--border-strong`        | 40% opacity |
| Primary `.btn-primary` | `--inverse-bg`, `--inverse-fg`, weight 600    | 86% opacity                            | 40% opacity |
| Danger `.btn-danger`   | `--bg`, `--danger` text, border at 35% danger | `--danger-bg`, solid `--danger` border | 40% opacity |

The default size is 32px tall with 12px padding (Undo, Reject, Run & send output, Stop). `.btn-lg` is 40px with 16px padding (Start session, Send files, Apply in the review footer). All buttons use the focus ring. Loading state: keep the width, replace the label with "Applying…" and the like, and disable the button.

### Diff card

A 1px border with a 12px radius on `--bg`. There are three states:

1. **Pending (review)**: `--border-strong` edge.
   - Header row (12px 16px): a file icon (16px, `--fg-muted`), the path in mono 13px `--fg`, then meta in 12px `--fg-muted`: "Modified · " followed by `+6` in `--success` and `−2` in `--danger`.
   - Body: a hairline above, then mono 13px/21px rows with 16px side padding. Added rows have a `--success-bg` background and a `+ ` prefix. Removed rows have `--danger-bg` and a `- ` prefix. Context rows have no fill. Long bodies collapse after 12 lines behind a "Show N more lines" row.
   - Footer: a hairline above, `--bg-hover` fill, and "Review before applying" (12px muted) on the left. **Reject** (secondary) and **Apply** (primary) are on the right.
2. **Applied**: collapses to one row with a `--border` edge. It shows a check icon in `--success`, the path, meta ("New file · +18"), the word "Applied" in `--success` at 13px/500, and an **Undo** button (secondary).
3. **Rejected / undone**: one row with the path and the meta struck through in `--fg-subtle`, the word "Rejected" or "Undone" in `--fg-muted`, and no actions.

On error (a write failed or the path was blocked), the card keeps its last state and adds a 12px `--danger` line under the header with the reason. It never shows a raw stack trace.

### Command card

A dashed `--border-strong` edge with a 12px radius and 12px 16px padding. It shows `$ npm run build` in mono 13px with a **Run & send output** button (secondary) on the right. While running, the button says "Running…" and is disabled. Afterwards the card shows the exit status: "Passed" in `--success` or "Failed (exit 1)" in `--danger`.

### Mode switch (`.segmented`, `role="radiogroup"`)

The track is `--bg-muted` with a 12px radius and 3px padding. It holds three equal segments, each 34px tall with an 8px radius. Inactive segments are transparent with `--fg-muted` text, turning `--fg` on hover. The active segment (`aria-checked="true"`) is `--bg-raised` with `--fg` text, weight 600 and `--shadow-xs`. Below it, a 12px `--fg-muted` line describes the chosen mode (from `MODE_DESCRIPTIONS`). Labels come from `MODE_LABELS` in `@bridge/shared`.

### Status pill (`.status` + `.dot`)

An 8px dot followed by 12px `--fg-muted` text, with no background or border. The dot's tone comes from `data-tone`:

States come from `ConnectionStatus` in `@bridge/shared`, and tones from `CONNECTION_STATUS_TONES`. Each app sets its own labels:

| `ConnectionStatus` | Dot         | Side panel text      | Desktop text            |
| ------------------ | ----------- | -------------------- | ----------------------- |
| `connected`        | `success`   | "Connected"          | "Connected"             |
| `connecting`       | `warning`   | "Connecting…"        | "Waiting for extension" |
| `not-paired`       | none (idle) | "Not paired"         | "Not paired"            |
| `app-not-running`  | none (idle) | "App not running"    | (not used)              |
| `error`            | `danger`    | "Can't reach Bridge" | "Server error"          |

### Text input (`.input`)

40px tall, 12px horizontal padding, 1px `--border`, `--radius-md`, `--bg`. Hover uses `--border-strong`. Placeholder is `--fg-subtle`. `aria-invalid="true"` turns the border `--danger`. The pairing-code field is mono at 16px with tabular digits, followed by a primary `.btn-lg`.

### Inline error (`.error-text`)

12px `--danger` text under the field or section it belongs to, with `role="alert"`. It says what happened and what to do next ("Too many wrong codes. Wait 60s, then start a new code in the Bridge app."). It never shows raw error codes.

### Pairing code

On the desktop's Extension section: the six digits in Geist Mono 24px/600 with a space after the third digit, then a 12px muted hint with the countdown ("Expires in 1:52"). The code disappears as soon as it's used, expires, or is cancelled by the lockout.

### Activity log row

An 8px dot and 13px `--fg` text with an 8px gap. Rows are spaced 8px apart, newest first. Dot tones: `success` for applied or passed, `warning` for waiting on review, `danger` for failed or blocked, and idle for informational events ("Sent 3 files to chat") and undone writes. Show about the last 20 rows; older ones scroll.

Classes `.activity`, `.activity-row`, `.activity-text`, `.activity-path` and `.activity-meta` live in `styles.css`. The text is two lines: the path in mono (truncated, full path in the tooltip) and a 12px `--fg-muted` meta line, "07:50 PM · Modified" or "07:50 PM · Blocked read · protected file" (reasons from `FILE_ERROR_LABELS`). Writes that can be undone end with a secondary **Undo** button. An undone row (`data-undone="true"`) strikes the path through in `--fg-subtle` and says "· undone". The section label row has **Undo last** on the right.

### Project section (desktop)

The project name (14px) and its path (mono 12px, muted, truncated) under the "Project" label. With no project, "No project open", a hint, and **Open folder…** as the view's primary `.btn-lg`; once a project is open it becomes a secondary "Open another folder…". **Recent** lists the other recent projects as plain rows split by hairlines: name (13px) over path (mono 12px, muted). Open errors use `.error-text`.

### Protected files (desktop settings)

A hint listing the built-in patterns in mono, then the user's patterns, each with a secondary **Remove**, then a 32px mono `.input` with an **Add** button. An invalid pattern sets `aria-invalid` and shows `.error-text`.

### Dev file tester (side panel, dev builds only)

Labelled "Test read (dev only)". A row with an operation `select`, a mono path input and **Send**; a mono textarea for write content; the JSON reply in a `--bg-muted` box with a hairline and `--radius-md`, mono 12px. It is a developer tool, so it skips the one-primary-action rule and is never shown in production builds.

### Files in context tree

Geist Mono 13px with one row per entry (~25px tall) and a 16px indent per level. Folders end in `/`. A `new` tag in `--success` mono follows files the chat created this session.

### Stop button

`.btn-danger` at 32px, in the panel footer on the right. It's only shown while a session is running. A click stops the full-auto loop immediately, and the label changes to "Stopping…" until the current step ends. The step counter to its left reads "Step N of M".

### Logo

The mark is a plus and a minus set on a diagonal, the two sides of a diff, drawn in white strokes on a rounded ink tile. It stands for what Bridge does: the chat proposes changes and you review them before they land. The geometry is on a 32-unit grid, with a 7.5 corner radius and 3.5 stroke width.

- Source: [`packages/shared/assets/logo.svg`](packages/shared/assets/logo.svg). React components draw it from `LOGO_MARK` in `@bridge/shared`, so the tile uses `--inverse-bg` and the strokes `--inverse-fg`. It inverts in dark mode.
- Sizes: 24px in bars, 16px minimum. Don't add a wordmark inside the tile, change its colours, or put it on a coloured background.
- Raster icons: `apps/extension/public/icons/icon-{16,32,48,128}.png` (128 has 8px padding) and `apps/desktop/resources/icon.png` (1024px, 100px padding for the macOS grid). To regenerate them, render `logo.svg` with resvg (`@resvg/resvg-js`) at those sizes.

### Icons

Use outline icons 16px with a 1.5px stroke (Lucide style): check, file, arrow-up and folder. Icons inherit `currentColor`. None are installed yet. Add `lucide-react` when the first icon is needed.

## Don'ts

- Don't use colour outside the semantic tokens, and don't add a brand accent hue.
- Don't use shadows beyond the two `--shadow-xs` uses, and no gradients or blur.
- Don't use raw hex values in components.
- Don't use all-caps labels or Title Case buttons.
- Don't use OpenAI or Codex names, logos or colours anywhere in Bridge's UI.
