# Bridge design system

Clean, neutral, black on white. The chat is the work, and Bridge's UI should feel like part of it rather than a layer on top. The reference is the mockup with a chat column on the left (assistant text, diff cards, command card, composer) and the Bridge side panel on the right (project, mode, actions, files, activity, Stop).

Tokens live in [`packages/shared/src/tokens.css`](packages/shared/src/tokens.css), and base components in [`packages/shared/src/styles.css`](packages/shared/src/styles.css), which imports the tokens. Both apps import `@bridge/shared/styles.css`. The cards injected into the chat load `tokens.css` into their shadow roots (`:root` becomes `:host`) and add their own [`card.css`](apps/extension/src/content/chat/cards/card.css). If this file and the CSS disagree, fix whichever is wrong in the same change.

## Principles

- **Neutral first.** Surfaces are white (or near-black in dark mode), text is ink, and borders are hairlines. The only colours are the semantic ones below.
- **Colour means state.** Green means added, red means removed or destructive, orange means waiting on you, and grey means idle. A result row is coloured by what it did (a new file is green, a delete red, the rest neutral), never just for having worked. Nothing is coloured for decoration.
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
- **Desktop app**: see "Desktop app" below.

### Chat elements

- **User message**: right-aligned bubble, `--bg-muted`, radius 18px, padding 10px 16px, 14px text.
- **Assistant text**: 14px/1.5 on the page background. Inline code is Geist Mono 13px on `--bg-muted` with a 6px radius and 1px 5px padding.
- **Composer**: a full pill, 48px tall, with a 1px `--border` and `--shadow-xs`. Placeholder text is `--fg-subtle`. The send button is a 32px circle in `--inverse-bg` with an up-arrow icon.

## Color tokens

| Token             | Light     | Dark                  | Use                                                            |
| ----------------- | --------- | --------------------- | -------------------------------------------------------------- |
| `--bg`            | `#ffffff` | `#0d0d0d`             | Page, cards, secondary buttons                                 |
| `--bg-muted`      | `#f3f3f3` | `#1c1c1c`             | User bubble, inline code, segmented track                      |
| `--bg-hover`      | `#f7f7f7` | `#161616`             | Button hover, diff-card footer                                 |
| `--bg-raised`     | `#ffffff` | `#2e2e2e`             | Active mode segment (sits above the track)                     |
| `--fg`            | `#111111` | `#ededed`             | Primary text, file paths                                       |
| `--fg-muted`      | `#5c5c5c` | `#a3a3a3`             | Labels, meta ("New file · +18"), hints                         |
| `--fg-subtle`     | `#6e6e6e` | `#858585`             | Placeholders, version, hunk headers, file sizes                |
| `--border`        | `#e5e5e5` | `#262626`             | Hairlines, card and button edges                               |
| `--border-strong` | `#d4d4d4` | `#3a3a3a`             | Pending diff card, dashed command card, hovered button         |
| `--inverse-bg`    | `#111111` | `#ededed`             | Primary button, send button, logo tile                         |
| `--inverse-fg`    | `#ffffff` | `#0d0d0d`             | Text and icons on `--inverse-bg`                               |
| `--success`       | `#1a7f37` | `#3fb950`             | "Created", `+N`, "new" tag, connected dot, the `+` result icon |
| `--success-bg`    | `#e8f6ec` | `rgb(63 185 80/.12)`  | Added diff lines                                               |
| `--danger`        | `#c4261d` | `#f2655c`             | `−N`, "Deleted", Stop, destructive buttons                     |
| `--danger-bg`     | `#fdeceb` | `rgb(242 101 92/.12)` | Removed diff lines, danger button hover                        |
| `--warning`       | `#b54f0a` | `#e8853d`             | "Waiting for review" dot, warning text                         |
| `--idle`          | `#a3a3a3` | `#6b6b6b`             | Neutral activity dot, "Not connected"                          |

Each colour token is `light-dark(light, dark)`, so `color-scheme` picks the theme: it follows the system, the desktop app's **Appearance** setting overrides it with `data-theme` on `<html>`, and the chat cards follow the chat page's `html.light` / `html.dark`. Components use only tokens and never raw hex values.

**Contrast.** Every text token (`--fg`, `--fg-muted`, `--fg-subtle`, `--success`, `--danger`, `--warning`) meets WCAG AA (4.5:1) on `--bg`, `--bg-muted` and `--bg-hover` in both themes; `tokens.test.ts` checks it. Change a value only with that test green.

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
- **Elevation**: `--shadow-xs` (`0 1px 2px rgb(0 0 0/.06)`) appears only on the composer and the active mode segment. There are no other shadows, gradients or blur. The chat cards have none.
- **Focus**: a 2px ring in `--fg`, offset 2px (`--focus-ring`), shown on `:focus-visible` only. Every control can be reached and used from the keyboard: radio groups (mode, appearance) move with the arrow keys, the project menu with arrows, Home/End and Escape, and focus returns to where it came from when a menu or detail view closes.
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

Injected right after the code block it describes, in a closed shadow root, so the page's CSS can't reach it and its CSS can't leak out. It follows the page's light/dark class (`html.dark`), falling back to `prefers-color-scheme`. A 1px border with a 12px radius on `--bg`, 12px above and below. Everything from the chat (paths, diff lines) is rendered as text.

1. **Pending (review)**: `--border-strong` edge.
   - Header row (8px 16px, at least 48px): a file icon (16px, `--fg-muted`), the path in mono 13px `--fg` (truncated, full path in the tooltip), the status badge(s), then meta in 12px `--fg-muted`: "Modified · " followed by `+6` in `--success` and `−2` in `--danger` ("New file", "No changes"). While the file is read, the meta says "Reading…". On the right, a **Hide diff / Show diff** toggle (12px muted, chevron).
   - Body: a hairline above, then mono 13px/21px rows with 16px side padding, scrolling past 480px. Hunk headers (`@@ -1,3 +1,4 @@`) are `--fg-subtle`. Added rows have a `--success-bg` background and a `+ ` prefix. Removed rows have `--danger-bg` and a `- ` prefix. Context rows have no fill. At most 400 rows render; a full-width "Show all N lines" row under them renders the rest.
   - Footer: a hairline above, `--bg-hover` fill, a 12px hint on the left, and **Reject** (secondary) and **Apply** (primary, `.btn-lg`) on the right. **Retry** (secondary) appears when the read failed for a reason other than the sandbox.
   - Hints: "Review before applying." by default; "Already up to date." for unchanged; "Bridge won't write this file." when blocked; in `--warning`: the partial warning, "This looks like part of a file… Click again to apply anyway." while confirming (the button reads **Apply anyway**), and "The file was updated since this diff was first shown. This is the new diff." after a conflict; "Session ended. Start a new one to apply." when the session is over (every button disabled).
2. **Applied**: one row with a `--border` edge: the result icon, the path, meta ("New file · +18 −0"), the result word at 13px/500 (see "Result rows"), the time, and an **Undo** button (secondary; "Undoing…" while busy).
3. **Rejected / undone**: one row with the path and the meta struck through in `--fg-subtle`, the word "Rejected" or "Undone" in `--fg-muted`, and no actions.

**Badges** are mono 12px tags with a 6px radius and a 1px border, 18px tall. Tone comes from colour of text and border (35% mix), never a fill:

| Badge       | Tone      | When                                                                   |
| ----------- | --------- | ---------------------------------------------------------------------- |
| `new`       | `success` | The file doesn't exist yet                                             |
| `modified`  | neutral   | The file exists and the content differs                                |
| `unchanged` | neutral   | Same text as on disk (line endings ignored). Apply is disabled         |
| `conflict`  | `warning` | The file changed after the card read it; the diff shown is the new one |
| `blocked`   | `danger`  | The sandbox refused the path, or the file is binary or over 1 MB       |
| `partial?`  | `warning` | Shown next to the others when the content has a placeholder comment    |

**`format fixed`** (neutral, any card: diff, READ, RUN, DELETE, RENAME) sits after the other badges when the chat's marker was missing its closing `@@` and Bridge read it anyway. Its tooltip says so. It changes nothing about what the card does.

On error (a write failed, the app isn't connected), the card keeps its state and adds a 12px `--danger` line under the header with the reason (`role="alert"`). It never shows a raw code or stack trace.

### Result rows

What a click (or Auto-apply) did, on the chat cards' applied rows and the app's Activity list. Colour follows the kind of change, not the fact that it worked; the word and the time say it's done, so there's no check icon.

| Kind     | Icon   | Word       | Tone                                         |
| -------- | ------ | ---------- | -------------------------------------------- |
| Created  | `+`    | "Created"  | `success` icon and word (the only green one) |
| Modified | pencil | "Modified" | neutral (`--fg-muted` icon, word)            |
| Renamed  | arrow  | "Renamed"  | neutral                                      |
| Deleted  | trash  | "Deleted"  | `danger` icon and word; path struck through  |

An automatic change adds a muted 12px "auto" after the word on a card, and "· auto" in an Activity row's meta. An undone row loses its tone and is struck through in `--fg-subtle`. Commands, refusals and loop events keep the dot. The side panel's "N edits applied" row has a neutral dot.

### Message bar (Apply all, Undo all)

Under the last diff card of a reply. Same card frame with a `--border` edge, holding only a footer row. **Apply all (N)** (primary 32px, "Applying…") shows with two or more applicable files (pending, readable, changed, not `partial?`), hint "Applies each file in order and stops at the first problem." **Undo all (N)** (secondary, "Undoing…") shows with two or more applied files, hint "Undoes this reply's edits, newest first." If either stops, the hint turns `--warning`: "Stopped at path. Its card says why." With neither, the bar is hidden.

### READ card

At the end of a reply that asked for files with `@@READ`. Pending-card frame (`--border-strong`). Header: file icon and "The chat asked for N files" (13px/500). Then one row per path (mono 13px, ~25px tall): file icon, path, and on the right either "1,204 chars" (12px muted), "Reading…", or a `danger` badge "blocked · protected file" with the path struck through in `--fg-subtle`. Footer: a hint with the total ("12,345 characters. Bridge puts them in the message box; you press send."), followed by "N likely secrets were replaced with [redacted]." when any were, in `--warning` above 30,000 characters ("The chat may turn this into an attachment or cut it off."), and **Send these files** (primary `.btn-lg`). After sending, the hint says "Added to the message box. Review it and press send." and the button reads **Send again**.

### Format card

Last under a reply that looks meant for Bridge but missed its format (a marker with a typo, a file block with a path above it and no marker, `@@FILE` with no block, a "rest unchanged" placeholder). Pending-card frame with a `--warning` edge at 35% and the alert icon in `--warning`. Header: "The chat didn’t use Bridge’s format" (13px/500). Then up to three 13px `--fg-muted` lines saying what Bridge couldn't read ("Not a Bridge marker: `@@RUNS npm test@@`", "A code block under “src/app.ts” has no @@FILE marker."), and "And N more." Footer: the hint "Bridge ignored what it couldn’t read. A reminder asks the chat to redo the reply." in `--warning`, and **Send format reminder** (primary), which puts the reminder in the message box without sending. After that the hint reads "The reminder is in the message box. Press send." (or, when Full auto sent it, "Full auto sent a format reminder.") and the button **Insert again**. The card never names the chat's vendor.

### Interrupted card

Last under a reply that was cut off (an error or the network in its turn, the page's Continue generating, or Bridge stopping a reply stuck after sleep). The format card's frame: `--warning` edge at 35%, the alert icon in `--warning`. Header: "The chat’s reply was interrupted" (13px/500). Then 13px `--fg-muted` lines: "It stopped after `@@FILE src/one.ts@@`." (or "It stopped before its first Bridge marker."), and "src/two.ts was cut off, so Bridge won’t apply it." when the cut fell in a file (that file's diff card shows `partial?`). Footer: a `--warning` hint ("Bridge applies only what came through whole. Ask the chat to continue.", or "Continue generating keeps the same reply. Or ask the chat to continue." when the page offers it), then **Insert continuation** (primary; secondary when **Continue generating**, the page's own button, is there as the primary). Insert never sends. After: "The request is in the message box. Press send." and **Insert again**; "The chat is continuing the same reply."; or, when Full auto did it, "Full auto asked the chat to continue." The card never names the chat's vendor and isn't saved in `chrome.storage.local`.

### Mode tag on cards

Pending diff cards and RUN cards start their footer hint with the app's mode ("Manual", "Auto-apply", "Full auto") in 12px/500 `--fg`, then a hairline `--border-strong` divider and the hint. Applied cards say what they did (see "Result rows"), with a muted "auto" when Auto-apply or Full auto did it. A diff card Auto-apply left for a click because the file is gated says, in `--warning`: "This file can change what commands do, so it needs your click in every mode. Review it, then Apply."

### RUN card (command)

One per `@@RUN`, after the READ card. A **dashed** `--border-strong` edge (the only dashed line in the system), 12px radius. Header: `$` in `--fg-subtle` mono, the command in mono 13px `--fg` (truncated, full text in the tooltip), a badge, the duration (12px muted) after a run, and **Hide output / Show output** on the right.

| Badge         | Tone      | When                                       |
| ------------- | --------- | ------------------------------------------ |
| `allowlisted` | neutral   | Matches the app's allowlist                |
| `not allowed` | `danger`  | Not on the allowlist, or uses shell syntax |
| `running`     | `warning` | Running                                    |
| `exit 0`      | `success` | Exited 0                                   |
| `exit N`      | `danger`  | Exited non-zero                            |
| `timed out`   | `danger`  | Killed at the timeout                      |
| `cancelled`   | neutral   | Cancelled (Stop or Cancel)                 |
| `failed`      | `danger`  | Couldn't start                             |

Body: the output, mono 13px/21px, wrapping, scrolling past 480px, the last 400 lines with a "Show all N lines" row above them. Footer (`--bg-hover`): the mode tag and a hint, then **Cancel** (`.btn-danger`) while running, else **Send output** (primary) once there's a result and **Run** (primary before a run, secondary "Run again" after). A command that isn't allowed has no Run; its hint says "Add it to the allowlist in the Bridge app." Shell syntax gets the parser's reason in `--danger`.

### Page chip

In a corner of the page (default bottom-right, 16px in; top corners sit 72px down), in its own closed shadow root. A pill: 1px `--border`, `--bg`, `--radius-full`, no shadow. Inside: the handle (an 8px dot, `success` while a run goes, `warning` paused, idle otherwise, and the mode, 12px/600), then in Full auto the counter `3 / 10` (tabular), the state in `--fg-muted` ("Waiting for the reply", "Waiting for the chat to finish (resumed after sleep)", "Caught up after sleep", "Paused · step limit", "Paused · reply cut off", "On") and a 28px pill **Stop** (`.btn-danger`). Shown while the tab's session is active, or while a run isn't idle. Drag the handle to another corner (it snaps to the nearest), or focus it and use the arrow keys; the corner is remembered.

- **Collapsed outside Full auto**: just the dot in an 8px-padded circle. Hover or keyboard focus opens it to show the mode. In Full auto it's always fully open.
- **Clear of the composer**: a bottom corner sits at least 96px up, and higher if the composer, or a banner over it, shares the chip's column: 12px above the topmost of them (`chipBottom`). It measures on every render, on resize and on each 1s poll, so a banner appearing moves it.

### Page notice

A one-line pill at the top centre of the page (16px down), same frame as the chip, 13px text and a 28px secondary button: "This chat's Bridge session is active in another tab." with **Move here**, or (warning border at 35%) "Bridge was updated or reloaded. Reload the page to use it here." with **Reload**.

### DELETE and RENAME cards

After the message bar, before the READ card, one per marker. The same frame and header as a diff card, no body.

- **DELETE, pending**: the border and the trash icon are `--danger` (35% border), the path, **Copy path**, a `delete` badge (`danger`) and the size ("1.2 KB", 12px muted). Footer hint in `--danger`: "Bridge will delete this file. It keeps a backup, so you can undo." In Auto-apply and Full auto it starts "Deletes always need your click, even in this mode." Buttons: **Reject** (secondary) and **Delete file** (`.btn-danger .btn-lg`, "Deleting…").
- **RENAME, pending**: an arrow icon, `old → new` in mono (old in `--fg-muted`, the arrow in `--fg-subtle`), a neutral `rename` badge, the size. **Reject** and **Rename** (primary `.btn-lg`).
- Other badges: `missing` (`warning`, no file there; nothing to do), `exists` (`warning`, the new path is taken), `conflict` (`warning`, changed on disk since the card checked), `blocked` (`danger`).
- **Applied**: like a diff card's applied row (see "Result rows"): trash icon, struck path and "Deleted" in `--danger`, or arrow icon and "Renamed" neutral; the time, and **Undo**. Rejected and undone rows are struck through.

### Card conventions

Every card's header is: icon, path (or title), **Copy path** (a 24px icon button, `--fg-subtle`, "Copied" for 1.5s), badges, meta, spacer, toggle (**Hide diff / files / output**, which collapses the card to its header and footer). The card is a labelled group, and keeps keyboard focus on the same control when it redraws (Apply becomes Undo, so focus moves to Undo). Applied rows show the time ("07:50 PM", 12px muted, tabular). **Show** from the side panel gives the card a focus ring.

A diff card for a path the same reply edits again says, in `--warning`, "This reply has another version of this file further down. Apply all uses the last one." (or "…This is the last version." on the last). Binary or over-1 MB content gets `blocked` and no diff.

### Mode switch (`.segmented`, `role="radiogroup"`)

The track is `--bg-muted` with a 12px radius and 3px padding. It holds three equal segments, each 34px tall with an 8px radius. Inactive segments are transparent with `--fg-muted` text, turning `--fg` on hover. The active segment (`aria-checked="true"`) is `--bg-raised` with `--fg` text, weight 600 and `--shadow-xs`. Below it, a 12px `--fg-muted` line describes the chosen mode (from `MODE_DESCRIPTIONS`). Labels come from `MODE_LABELS` in `@bridge/shared`.

### Status pill (`.status` + `.dot`)

An 8px dot followed by 12px `--fg-muted` text, with no background or border. The dot's tone comes from `data-tone`:

States come from `ConnectionStatus` in `@bridge/shared`, and tones from `CONNECTION_STATUS_TONES`. Each app sets its own labels:

| `ConnectionStatus` | Dot         | Side panel text         | Desktop text            |
| ------------------ | ----------- | ----------------------- | ----------------------- |
| `connected`        | `success`   | "Connected"             | "Connected"             |
| `connecting`       | `warning`   | "Connecting…"           | "Waiting for extension" |
| `not-paired`       | none (idle) | "Not paired"            | "Not paired"            |
| `app-not-running`  | none (idle) | "App not running"       | (not used)              |
| `error`            | `danger`    | "Can't reach Bridge"    | "Server error"          |
| `update-app`       | `warning`   | "Update the Bridge app" | "Update the Bridge app" |
| `update-extension` | `warning`   | "Update the extension"  | "Update the extension"  |

In the two `update-*` states (the app and the extension speak different protocol versions), the side panel's Connection section says which side to update with **Try again**, and the app shows a `.notice` on the Session and Settings pages.

### Text input (`.input`)

40px tall, 12px horizontal padding, 1px `--border`, `--radius-md`, `--bg`. Hover uses `--border-strong`. Placeholder is `--fg-subtle`. `aria-invalid="true"` turns the border `--danger`. The pairing-code field is mono at 16px with tabular digits, followed by a primary `.btn-lg`.

### Inline error (`.error-text`)

12px `--danger` text under the field or section it belongs to, with `role="alert"`. It says what happened and what to do next ("Too many wrong codes. Wait 60s, then start a new code in the Bridge app."). It never shows raw error codes.

### Pairing code

On the desktop's Extension section: the six digits in Geist Mono 24px/600 with a space after the third digit, then a 12px muted hint with the countdown ("Expires in 1:52"). The code disappears as soon as it's used, expires, or is cancelled by the lockout.

### Pairing fingerprint

Once the code is used, both the app (Extension section) and the side panel show the fingerprint in the pairing code's style (Geist Mono 24px/600, `0.08em` tracking, tabular): two groups of four hex characters, `a1b2 c3d4`, labelled for screen readers one character at a time. Above it a 12px muted line says to check the other side shows the same; below, a hint says what a mismatch means. Actions: **They match** (primary `.btn-lg`) and **Cancel** (secondary). The app confirms first; then its hint reads "Confirmed here. Now confirm it in the side panel…" with the countdown and only **Cancel**. Confirming in the side panel first shows an `.error-text`: "Click “They match” in the Bridge app first, then confirm here."

### Activity log row

A 16px result icon (file changes, see "Result rows") or an 8px dot (everything else), and 13px `--fg` text with an 8px gap. Rows are spaced 8px apart, newest first. Dot tones: `success` for a command that passed, `warning` for waiting on review, `danger` for failed or blocked, and idle for informational events ("Sent 3 files to chat"). Show about the last 20 rows; older ones scroll.

Classes `.activity`, `.activity-row`, `.activity-text`, `.activity-path` and `.activity-meta` live in `styles.css`. The text is two lines: the path in mono (truncated, full path in the tooltip) and a 12px `--fg-muted` meta line, "07:50 PM · Modified", "07:50 PM · Modified · via chat" (applied from a diff card) or "07:50 PM · Blocked read · protected file" (reasons from `FILE_ERROR_LABELS`). Writes that can be undone end with a secondary **Undo** button. Automatic writes say "· auto" instead of "· via chat". Command rows show the command in mono and "Passed · 1.2s" (`success`), "Exit 1 · 1.2s" (`danger`), "Timed out" or "Cancelled". A write left for a click reads "Left for a click · gated file". A Full auto run's rows (its steps, writes and commands) sit together under "Full auto run · N messages sent" (12px/500 muted), indented 12px with a 1px `--border-strong` line on the left. An undone row (`data-undone="true"`) strikes the path through in `--fg-subtle` and says "· undone". The section label row has **Undo last** on the right.

### Project section (desktop)

The project name (14px) and its path (mono 12px, muted, truncated) under the "Project" label. With no project, "No project open", a hint, and **Open folder…** as the view's primary `.btn-lg`. Switching projects (recents, Open folder…) lives in the header's project switcher. A missing folder adds the "Project missing" notice. Open errors use `.error-text`.

### Protected files (desktop settings)

A hint listing the built-in patterns in mono, then the user's patterns, each with a secondary **Remove**, then a 32px mono `.input` with an **Add** button. An invalid pattern sets `aria-invalid` and shows `.error-text`.

### Dev file tester (side panel, dev builds only)

Labelled "Test read (dev only)". A row with an operation `select`, a mono path input and **Send**; a mono textarea for write content; the JSON reply in a `--bg-muted` box with a hairline and `--radius-md`, mono 12px. It is a developer tool, so it skips the one-primary-action rule and is never shown in production builds.

### Session section (side panel)

Label "Session" with **End session** (secondary) on the right of the label row while a session is active. Below it, a status line: a `success` dot and "Session active · e2e00000…" (the conversation id shortened to 8 characters in mono, full id in the tooltip), or "Session active · waiting for your first message" in a new chat. Then three activity-style rows: "N edits applied" (`success` dot when N > 0), "N waiting for review" (`warning` dot when N > 0), and "Sent N files to the chat" with the paths as a muted mono meta line.

With no session, "No session" (or "Session ended"), a hint, a line with the prompt's size ("1,185 characters, 3 of 3 files listed."; `--warning` above 30,000), and **Start session** as the view's primary `.btn-lg`. With no chat in the tab: "No chat in this tab" and a hint to open or reload one.

**Layout notice**: when the tab reports it can't read the page, the section shows a bordered box (1px warning at 35%, `--radius-md`, 12px padding, 13px `--fg`): "Bridge can't read this page layout. The chat page may have changed. Cards and sessions are off until Bridge is updated."

### Send files (side panel)

Label "Send files" with a **Clear** text button when anything is selected. A 32px mono filter input, then the tree in a 1px `--border` box with `--radius-md`, at most 320px tall and scrolling: Geist Mono 13px, one row per entry (~25px), 16px indent per level, a checkbox (`accent-color: var(--fg)`) before each entry. Folders end in `/`, open on click, and are `--fg-muted` while closed; their checkbox selects every file under them and shows indeterminate when partly selected. Files show their size in 12px `--fg-subtle` tabular figures on the right. Collapsed entries (`node_modules`) can't be selected. While filtering, matching files show as a flat list of full paths (first 200).

**Budget meter** under the tree: a 4px `--bg-muted` track with an `--fg` fill (`--radius-full`) for the share of 30,000 characters, turning `--warning` past it. Below, a 12px hint: "3 files · about 4,210 of 30,000 characters", plus the warning line past the limit and an error past 50 files. Then **Insert N files** (primary `.btn-lg`) and a status line after sending.

### Files in context (side panel)

Label "Files in context" with **Resend changed (N)** (secondary) on the right while any are stale or missing. One row per file sent this session, newest first, ~28px: the path in mono 13px (truncated), a tag (`changed` in `--warning`, `deleted` in `--danger`; mono 12px, 1px border at 35%), the characters it took ("1,204 chars", 12px `--fg-subtle`, tabular), and a 24px icon button (×, labelled "Remove path from the list"). Under the list a 12px hint with the total, and when the project is too big to watch: "Bridge checks only these." Empty: "Files you send to the chat show up here, with how much of the message each one took."

### Requests (side panel)

READ and RUN cards in the tab still waiting for a click. One row each, ~36px: "Files" or "Run" (12px muted, 36px wide), the paths or `$ command` in mono (truncated), a `danger` tag (`not allowed` / `blocked`) when it can't go ahead, and **Show** (secondary), which scrolls the card into view and focuses its button. Empty: "Nothing waiting."

### Side panel sections and states

In order: Connection (label row with **Unpair** as a text button; the project name and path, or the warning notice "The project folder is missing…"), Session, Mode, Full auto, Command, Requests, Files in context, Send files. Last, in every state (pairing included), the meta row (`.panel-meta`, pushed to the bottom of the body above a hairline): the version as "Bridge 1.2.0-beta.1" (12px mono muted; the manifest's `version_name`, else `version`) and **Copy diagnostics** as a text button on the right; after a copy, a 12px muted status line "Diagnostics copied. Paste them into your bug report." (or "Couldn’t copy…"). Before the worker answers: placeholder bars (`.skeleton`, `--bg-muted`, 12px tall, `--radius-sm`; nothing animates). In a tab whose session lives elsewhere: "Session active in another tab", a hint, and **Move here** (primary `.btn-lg`).

### Stop button

`.btn-danger` at 32px, in the side panel's sticky footer and the app's Full auto strip, on the right, shown only while a Full auto run is going (not idle or stopped). A click stops the loop and its command at once; in the app the label reads "Stopping…" until the loop reports back. The step counter to its left reads "Step N of M" (12px muted, tabular).

### Side panel: Mode, Full auto, Command

- **Mode**: a read-only badge (`.mode-badge`, 1px `--border-strong`, 6px radius, 13px/600; `warning` text and border for Full auto) and the mode description plus "Change the mode in the Bridge app." When a session starting or ending turned Full auto off, a `--warning` hint below: "Full auto turned off: it’s per session." It goes when Full auto is on again.
- **Full auto** (in Full auto, or while a run exists): a status line with a dot and the state (or, after sleep, "Waiting for the chat to finish (resumed after sleep)" / "Caught up after sleep") and `step / limit`. Paused: the reason in the bordered warning notice (with its detail: "The chat’s reply was interrupted after `@@FILE src/one.ts@@`.", "A command was interrupted by sleep: pnpm test"), then the buttons for that reason, one primary: **Resume**; **Continue for N more** at the step limit; **Stop & continue** for a reply stuck after sleep; **Continue generating** (primary, when the page offers it) and **Resume** for a cut-off reply; **Re-run** and **Skip** for a command sleep interrupted. Stuck and cut-off pauses add a 12px muted hint saying what the button does. Stopped: "Stopped. Nothing was reverted; undo is still available." and **Allow Full auto again** (secondary).
- **Command** (while one runs, or after one ran): label row with **Cancel** (`.btn-danger`) while running; `$ command` in mono; "Running…", "Passed" or "Failed (exit N)" (`--danger`); the last 200 lines in a `--bg-muted` mono 12px box, 240px tall at most.

### Desktop app

```
┌───────────────────────────────────────────────────────────────────────────┐
│ [■] Bridge  [📁 acme-web ▾]                         ● Connected  [Manual]  │ 56px
├───────────────────────────────────────────────────────────────────────────┤
│ ● Full auto · Applying and running              Step 3 of 10      [Stop]  │ while a run goes
├──────────────┬────────────────────────────────────────────────────────────┤
│ Session      │            ┌ 640px column, 32px top padding ┐              │
│ Activity     │            │ sections 32px apart             │              │
│ Settings     │            └─────────────────────────────────┘              │
│              │                                                            │
│ ? Getting    │                                                            │
│   started    │                                                            │
│ Bridge 0.1.0 │                                                            │
└──────────────┴────────────────────────────────────────────────────────────┘
```

- **Header** (56px, hairline below, draggable window area): logo and "Bridge"; the **project switcher** (32px secondary-style button: folder icon, name 13px/600, a `missing` warning tag when the folder is gone, chevron) opening a menu (1px `--border-strong`, `--radius-md`, no shadow) with "Recent" rows (name over mono path) and **Open folder…** with its shortcut; the status pill; the **mode pill** (24px, 1px `--border-strong`, 12px/600; `--warning` text and border in Full auto), which jumps to the mode switch.
- **Full auto strip**: under the header on every page while a run is going (not idle or stopped): a dot, "**Full auto** · state" (and the pause reason), "Step N of M" (12px muted, tabular) and **Stop** (`.btn-danger`). It's the app's Stop button; ⌘. does the same.
- **Nav**: 200px, hairline on the right. Items are 32px buttons with a 16px icon, 13px/500 `--fg-muted`; hover `--bg-hover`; the current page (`aria-current`) is `--bg-muted`, `--fg`, 600. At the bottom: **Getting started** and the version (12px `--fg-subtle`).
- **Page**: one 640px column. Section headings are the 12px muted label (as real `h2`s). In Settings they're 13px/600 `--fg` with a hairline below, and the page starts with an index of 28px pill buttons that jump to each section.
- **Empty state** (`.empty`): 13px `--fg-muted`, centred, 16px padding in a 1px **dashed** `--border-strong` box with `--radius-md`. (Dashed here marks "nothing yet", like the RUN card's edge marks "not run yet".)
- **Notice** (`.notice`): 1px warning border at 35%, `--radius-md`, 12px padding, 13px text; "Project missing" uses it with **Try again** and **Open folder…**.
- **Loading**: `.skeleton` bars, `--bg-muted`, 14px tall, `--radius-sm`. No shimmer.

### Desktop: Session page

The first-run checklist (when not dismissed), then Project, Extension, Mode, Running (while a command runs) and Recent activity (the last 5 rows and **View all**).

**Checklist**: a card (1px `--border-strong`, `--radius-lg`, 20px padding) titled "Get started" (14px/600), a close icon button, "N of 4 done" (12px muted), then an ordered list: a 16px check (`--success`) or circle (`--fg-subtle`), the step (13px; done ones `--fg-muted`) and, for the next step only, its hint (12px muted) and a secondary button that does it. When all are done the title reads "You're set up" with **Done**.

### Desktop: Activity page

Label row "Activity" with **Undo last**. A 32px search field with a search icon, then filter chips (28px pills, 1px `--border`, 12px/500 muted; pressed: `--inverse-bg` with `--inverse-fg`, `aria-pressed`): Writes, Deletes, Renames, Commands, Blocked, Automatic. Rows are full-width buttons (40px min, `--radius-md`, hover `--bg-hover`) with the dot, the two-line text and a chevron; Full auto runs are grouped as before. Nothing matches: the empty box with **Clear filters**.

**Detail**: "Back to activity" (text button), the path in mono 14px/600 (`old → new` for a rename) with **Undo** on the right, the status line (dot, date and time, meta), the reason in a notice for refusals, then the **diff viewer** (the card's diff rows: mono 13px/21px, `--success-bg` / `--danger-bg`, hunk headers `--fg-subtle`, 1px `--border`, `--radius-lg`, scrolling past 60% of the window, "Show all N lines" past 400) or the command line and its full output in the `--bg-muted` output box. A delete shows the whole file as removed rows; a rename says "Moved without changing its content."

### Toasts (desktop)

Bottom-right, 20px in, up to three stacked, 4s each, `aria-live="polite"`: a dot, the message (13px) with an optional mono detail, and a 12px muted hint on the next line. 1px `--border-strong`, `--radius-md`, `--bg`, no shadow. For: auto-applied edits, Full auto pausing or finishing, Full auto turning off because a session started or ended ("Full auto turned off: it’s per session."), the project going missing, the extension disconnecting.

### Desktop: Mode, Commands, loop bar, toast

- **Mode**: the segmented switch. Choosing Full auto opens the native confirm dialog first. Under the description, in Full auto, a `--warning` hint that it sends messages and runs model-written code and turns off on restart, End session, unpair or project switch; then the loop status line (dot, state, "step N of M") and the pause reason in `--warning`.
- **Running** (while a command runs): label row with **Cancel**, `$ command` in mono, live output in a `--bg-muted` mono box (320px).
- **Commands**: before the project's list is confirmed, the suggestions as checkbox rows (mono, all ticked, the install command first) with, when the install command is among them, a hint that it installs only what package.json lists and that package.json changes need a click; and **Allow N commands** (primary). For a list confirmed before 1.1.0, a one-time `.notice` above the entries: "Add `npm install` to the allowlist?…", the same hint, **Add** (primary, labelled "Add npm install") and **Dismiss**. After: a hint that entries match exactly and `*` allows extra arguments, the entries with **Remove**, a mono input with **Add** (rejects shell syntax with the parser's reason, a misplaced `*`, and denied options naming the option). Once, after old entries were migrated to `*`, a `.notice` explains it with **Got it**. Then the command timeout and the install timeout (seconds, with a hint naming the four install commands), the step limit (messages), "Pause Full auto when a command fails" and "Catch up automatically after sleep" (on by default), each with its hint.
- **Settings** gains **Gated files** and **Hidden from commands** in the Protected files layout (defaults in mono, user entries with Remove, input and Add).
- **Settings** sections: Connection (port, extension, **Unpair** / **Pair again**), Project (protected and gated files), Commands (allowlist, timeout, hidden variables, PATH for commands with its source and any warning), Full auto (step limit, pause on failure), Backups (days to keep, **Open the backups folder**, **Clear for this project…** as `.btn-danger` behind a native dialog), Appearance (a segmented System / Light / Dark), About (the version as `Bridge 1.0.0` in mono, **Check for updates** as a secondary button, one status line under it: "Checking…", "You have the latest version.", "Bridge X.Y.Z is available." in `--fg` with a **View the release** link, or "Couldn’t reach GitHub…" with a link to the Releases page; then the "Check for updates when Bridge starts" checkbox and a hint that nothing is downloaded or sent. In dev and unsigned macOS builds only the version and a hint linking the Releases page). Between the status line and the button, when checks are on: **Update channel**, a 12px label and a segmented Stable / Beta (same control and keys as Appearance) with a hint for the chosen one, plus "This build starts on Beta." when it differs from the build's own. Then, in every build, a "Report a problem" subsection: **Copy diagnostics** and **Open logs folder** as secondary buttons and a hint on what diagnostics hold. A found update is also a toast ("Bridge X.Y.Z is available", hint "Settings → About has the link."); copying diagnostics (here or Help → Copy diagnostics) is a success toast "Diagnostics copied", hint "Paste them into your bug report.".
- Number fields are 88px mono `.input`s at 32px with a 12px muted unit; they save on blur and show `.error-text` with the allowed range.

### Logo

The mark is a plus and a minus set on a diagonal, the two sides of a diff, drawn in white strokes on a rounded ink tile. It stands for what Bridge does: the chat proposes changes and you review them before they land. The geometry is on a 32-unit grid, with a 7.5 corner radius and 3.5 stroke width.

- Source: [`packages/shared/assets/logo.svg`](packages/shared/assets/logo.svg). React components draw it from `LOGO_MARK` in `@bridge/shared`, so the tile uses `--inverse-bg` and the strokes `--inverse-fg`. It inverts in dark mode.
- Sizes: 24px in bars, 16px minimum. Don't add a wordmark inside the tile, change its colours, or put it on a coloured background.
- Raster icons: `apps/extension/public/icons/icon-{16,32,48,128}.png` (128 has 8px padding) and `packages/shared/assets/icon.png` (1024px, 100px padding for the macOS grid; electron-builder makes the macOS, Windows and Linux icons from it). To regenerate them, render `logo.svg` with resvg (`@resvg/resvg-js`) at those sizes.

### Icons

Use outline icons 16px with a 1.5px stroke (Lucide style). Icons inherit `currentColor` and are hidden from screen readers; a button with only an icon has an `aria-label`. The chat cards draw theirs with `createElementNS` from path data in `cards/dom.ts` (file, plus, pencil, chevron, alert, trash, arrow, copy, terminal). The desktop app draws its own the same way from `renderer/src/Icon.tsx` (chevron, check, circle, folder, session, activity, settings, help, back, close, search, plus, pencil, arrow, trash), so no icon package is needed. The check is only the onboarding checklist's.

## Landing page

`apps/site` (https://bridge.jpsoriaga.me) uses the same tokens, mapped into Tailwind v4's theme in `apps/site/src/styles/index.css` (`bg-bg-muted`, `text-fg-subtle`, `border-border-strong`…; Tailwind's palette is removed, so nothing else is available). Its buttons, badges, dots, segmented control and diff rows copy the rules above. What it adds, for a marketing page only:

- **Type**: display sizes above the app scale: the hero title (`text-display`, 36–60px, 600, `-0.035em`), section titles (`text-title`, 26–36px, 600) and lead text (`text-lead`, 16–18px). Body copy is 16px/1.6. Section labels are the 12px muted label over the title.
- **Layout**: one 1120px column, 16px gutters on phones and 32px from 640px; sections separated by a hairline and 64–96px of space.
- **Buttons**: `.btn-xl` (44px, 14px text) for the hero's and the download's calls to action. Download is the one primary per view.
- **Hero picture**: a chat reply and a diff card drawn in HTML from the "Diff card" spec, not a screenshot. Its Apply, Reject and Undo work on the picture.
- **Footer wordmark**: "Bridge" in Geist 900 at `-0.05em`, sized with `clamp()`/`vw` so it spans the content width at every size, cut off by the page's bottom edge (about a quarter of the letters). It's a faint grey a step off the background (`--border` fading into `--bg`) through `background-clip: text`: **the one gradient in the system**, decorative only (`aria-hidden`, not selectable), and exempt from the contrast rule. It fades in once when scrolled to, except under `prefers-reduced-motion`.
- **Theme**: follows the system, with a System / Light / Dark segmented switch in the header that sets `data-theme` and remembers the choice.

## Don'ts

- Don't use colour outside the semantic tokens, and don't add a brand accent hue.
- Don't use shadows beyond the two `--shadow-xs` uses (the site's theme switch reuses the segmented control's), and no gradients or blur (except the site's footer wordmark).
- Don't use raw hex values in components.
- Don't use all-caps labels or Title Case buttons.
- Don't use OpenAI or Codex names, logos or colours anywhere in Bridge's UI.
