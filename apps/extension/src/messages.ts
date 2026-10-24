import { z } from 'zod';
import {
  BackgroundLogsParams,
  BridgeConfig,
  DeleteParams,
  DownloadParams,
  ProcessId,
  ReadBinaryResult,
  ListParams,
  LoopId,
  LoopReport,
  OpId,
  ReadParams,
  RunId,
  RunParams,
  RunResult,
  Sha256Hex,
  TreeParams,
  Trigger,
  UndoParams,
  WriteParams,
  PairingCode,
  RenameParams,
  CONNECTION_STATUSES,
  ProjectInfo,
  type ConnectionStatus,
  type ProtocolAdvice,
  type FileErrorCode,
  type FileOutcome
} from '@bridge/shared';

/** A path from the chat. The desktop sandbox decides; this only bounds the size. */
const ChatPath = ReadParams.shape.path;
/** Most files one READ card or one "Send files" may send. */

/**
 * What the side panel can ask of the tab's Full auto loop: Stop, Resume, Continue for N more
 * at the step limit, and after sleep Skip (an interrupted command), Stop & continue (a stuck
 * reply) and the page's own Continue generating (a cut-off reply).
 */
export const LoopAction = z.enum([
  'stop',
  'resume',
  'continue',
  'skip',
  'stop-continue',
  'continue-reply'
]);
export type LoopAction = z.infer<typeof LoopAction>;

export const MAX_FILES_PER_SEND = 50;
/** Most images one Attach (or one READ card) adds to the message. */
export const MAX_ATTACHMENTS = 10;
/** A binary file's bytes between the content script and the worker, base64. */
const BinaryData = ReadBinaryResult.shape.data;

/**
 * `conversationId:messageId:slot:contentHash`. See `blockKey`. The slot is a diff card's
 * block index, `read` for the message's READ card, `d<n>` / `r<n>` for its n-th DELETE or
 * RENAME card, `a<n>` for its n-th image (Save to project) and `w<n>` for its n-th DOWNLOAD.
 */
export const BlockKey = z
  .string()
  .regex(/^[\w-]{1,64}:[\w-]{1,128}:(?:\d{1,4}|read|[draw]\d{1,4}):[0-9a-f]{16}$/);

export const CardState = z.enum(['pending', 'applied', 'rejected', 'undone']);
export type CardState = z.infer<typeof CardState>;

/** What a diff card remembers across reloads, in `chrome.storage.local` by block key. */
export const DiffCardRecord = z.strictObject({
  state: CardState,
  path: ChatPath,
  opId: OpId.optional(),
  /** For the collapsed applied row: what the write did. */
  kind: z.enum(['create', 'modify']).optional(),
  added: z.number().int().nonnegative().optional(),
  removed: z.number().int().nonnegative().optional(),
  /** Applied by Auto-apply or Full auto rather than a click. The card says "Auto-applied". */
  auto: z.literal(true).optional(),
  /** Epoch ms when it was applied, for the card's timestamp. */
  appliedAt: z.number().int().nonnegative().optional(),
  /** Epoch ms. Records older than 30 days are pruned. */
  updatedAt: z.number().int().nonnegative()
});
export type DiffCardRecord = z.infer<typeof DiffCardRecord>;

/** A DELETE or RENAME card. Applied by a click, or Full auto when the app allows it. */
export const ChangeCardRecord = z.strictObject({
  card: z.literal('change'),
  state: CardState,
  opId: OpId.optional(),
  /** Applied by Full auto ("Also approve automatically") rather than a click. */
  auto: z.literal(true).optional(),
  appliedAt: z.number().int().nonnegative().optional(),
  updatedAt: z.number().int().nonnegative()
});
export type ChangeCardRecord = z.infer<typeof ChangeCardRecord>;

/** A READ card: whether its files went into the composer. */
export const ReadCardRecord = z.strictObject({
  card: z.literal('read'),
  state: z.enum(['pending', 'sent']),
  updatedAt: z.number().int().nonnegative()
});
export type ReadCardRecord = z.infer<typeof ReadCardRecord>;

/** A generated image's Save to project card, or a DOWNLOAD card: where it went, and how. */
export const BinaryCardRecord = z.strictObject({
  card: z.enum(['asset', 'download']),
  state: CardState,
  /** Where it was saved (an image's path is the user's to choose). */
  path: ChatPath.optional(),
  opId: OpId.optional(),
  kind: z.enum(['create', 'modify']).optional(),
  auto: z.literal(true).optional(),
  appliedAt: z.number().int().nonnegative().optional(),
  updatedAt: z.number().int().nonnegative()
});
export type BinaryCardRecord = z.infer<typeof BinaryCardRecord>;

export const CardRecord = z.union([
  DiffCardRecord,
  ReadCardRecord,
  ChangeCardRecord,
  BinaryCardRecord
]);
export type CardRecord = z.infer<typeof CardRecord>;

const WindowId = z.number().int().nonnegative();

/** The side panel's first message on its port: which window it belongs to. */
export const PanelHello = z.strictObject({ type: z.literal('panel-window'), windowId: WindowId });
export type PanelHello = z.infer<typeof PanelHello>;

export const ConversationId = z.string().regex(/^[A-Za-z0-9-]{8,64}$/);
/** Where the page chip sits. The user drags it; the worker remembers. */
export const ChipCorner = z.enum(['bottom-right', 'bottom-left', 'top-left', 'top-right']);
export type ChipCorner = z.infer<typeof ChipCorner>;
export const LayoutHealth = z.enum(['ok', 'unknown']);

/** A file the chat was sent this session: what it cost and what it held then. */
export const SentFile = z.strictObject({
  path: ChatPath,
  /** Characters it took up in the message. */
  chars: z.number().int().nonnegative(),
  /** SHA-256 of the file as sent. Missing for files recorded before Bridge kept hashes. */
  hash: Sha256Hex.optional()
});
export type SentFile = z.infer<typeof SentFile>;

/** A READ or RUN card still waiting for a click, as the side panel lists it. */
export const PendingRequest = z.strictObject({
  /** Identifies the card on its page, for "Show". */
  id: z.string().max(200),
  kind: z.enum(['read', 'run', 'start', 'download']),
  /** The files asked for, or the command. */
  text: z.string().max(2_000),
  /** RUN: whether the allowlist allows it. READ: whether any file can be sent. */
  allowed: z.boolean()
});
export type PendingRequest = z.infer<typeof PendingRequest>;

/** chrome.runtime messages to the service worker, from the side panel or content script. */
export const WorkerRequest = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('get-status') }),
  z.strictObject({ type: z.literal('pair'), code: PairingCode }),
  // The fingerprints match (or don't): finish or drop the pairing in progress.
  z.strictObject({ type: z.literal('pair-confirm') }),
  z.strictObject({ type: z.literal('pair-cancel') }),
  z.strictObject({ type: z.literal('unpair') }),
  z.strictObject({ type: z.literal('retry') }),

  // Side panel: the chat session in the active tab.
  // `windowId`: the side panel's own window. Its active tab is the chat it acts on.
  z.strictObject({ type: z.literal('session-preview'), windowId: WindowId }),
  z.strictObject({ type: z.literal('session-start'), windowId: WindowId }),
  z.strictObject({ type: z.literal('session-end'), windowId: WindowId }),
  // Reloads the panel's active tab, so a chat tab opened before Bridge (re)loaded gets the
  // content script. Needs no permission and touches only that one tab.
  z.strictObject({ type: z.literal('reload-tab'), windowId: WindowId }),
  z.strictObject({ type: z.literal('get-tree') }),
  // One folder of the project, for the lazy tree. '' is the root.
  z.strictObject({ type: z.literal('get-list'), dir: ListParams.shape.dir }),
  // Files in context: send the changed ones again, or drop one from the list.
  z.strictObject({ type: z.literal('context-resend'), windowId: WindowId }),
  z.strictObject({ type: z.literal('context-remove'), windowId: WindowId, path: ChatPath }),
  // Moves this conversation's session to the panel's active tab.
  z.strictObject({ type: z.literal('session-move'), windowId: WindowId }),
  // Scrolls a pending READ or RUN card into view in the panel's active tab.
  z.strictObject({
    type: z.literal('reveal-request'),
    windowId: WindowId,
    id: z.string().max(200)
  }),
  z.strictObject({
    type: z.literal('send-files'),
    windowId: WindowId,
    paths: z.array(ChatPath).min(1).max(MAX_FILES_PER_SEND)
  }),
  // The Full auto loop in the panel's active tab. `continue` adds another step limit's worth.
  z.strictObject({
    type: z.literal('loop-control'),
    windowId: WindowId,
    action: LoopAction
  }),
  // Cancels the command running now, whoever started it.
  z.strictObject({ type: z.literal('run-cancel') }),
  // Background processes, from the side panel: Stop, its recent lines, open its URL.
  z.strictObject({ type: z.literal('process-stop'), procId: ProcessId }),
  z.strictObject({ type: z.literal('process-logs'), procId: ProcessId }),
  z.strictObject({ type: z.literal('process-open'), procId: ProcessId }),
  // Send files → Attach: project images go into the chat's message as real attachments.
  z.strictObject({
    type: z.literal('attach-files'),
    windowId: WindowId,
    paths: z.array(ChatPath).min(1).max(MAX_ATTACHMENTS)
  }),
  // Dev builds: what the page script sees on the panel's active tab, to fix selectors.
  z.strictObject({ type: z.literal('page-diagnostics'), windowId: WindowId }),
  // Copy diagnostics in the side panel: versions, states and recent events, as text.
  z.strictObject({ type: z.literal('diagnostics'), windowId: WindowId }),
  // The side panel's tip about Full auto in a background tab was dismissed, for good.
  z.strictObject({ type: z.literal('background-tip-seen') }),

  // Content script on chatgpt.com.
  z.strictObject({
    type: z.literal('chat-sync'),
    conversationId: ConversationId.nullable(),
    layout: LayoutHealth,
    /** The content script just started (a load or reload): any loop it had is gone. */
    start: z.literal(true).optional(),
    /** The tab's timers stalled: the computer slept. Reconnect now. */
    wake: z.literal(true).optional()
  }),
  z.strictObject({ type: z.literal('chat-read'), path: ChatPath }),
  z.strictObject({ type: z.literal('chat-stat'), path: ChatPath }),
  // A click, unless Full auto sends it because "Also approve automatically" allows it (the
  // app checks that setting itself).
  z.strictObject({
    type: z.literal('chat-delete'),
    path: ChatPath,
    baseHash: DeleteParams.shape.baseHash,
    trigger: Trigger.optional(),
    loopId: LoopId.optional()
  }),
  z.strictObject({
    type: z.literal('chat-rename'),
    from: ChatPath,
    to: RenameParams.shape.to,
    baseHash: RenameParams.shape.baseHash,
    trigger: Trigger.optional(),
    loopId: LoopId.optional()
  }),
  z.strictObject({ type: z.literal('chip-corner'), corner: ChipCorner }),
  // The page says this conversation doesn't exist (deleted, or a 404): end its session.
  z.strictObject({ type: z.literal('chat-gone') }),
  // "Move here" from the notice in a tab whose session lives in another tab.
  z.strictObject({ type: z.literal('chat-move-here') }),
  // The READ and RUN cards still waiting in this tab, for the side panel.
  z.strictObject({
    type: z.literal('chat-requests'),
    requests: z.array(PendingRequest).max(100)
  }),
  z.strictObject({
    type: z.literal('chat-write'),
    path: ChatPath,
    content: WriteParams.shape.content,
    baseHash: Sha256Hex.optional(),
    trigger: Trigger,
    loopId: LoopId.optional(),
    /** A partial-looking file Full auto applies because "Also approve automatically" allows it. */
    autoApproved: z.literal(true).optional()
  }),
  z.strictObject({
    type: z.literal('chat-run'),
    argv: RunParams.shape.argv,
    trigger: Trigger,
    loopId: LoopId.optional()
  }),
  z.strictObject({ type: z.literal('chat-run-cancel'), runId: RunId }),
  // An image the chat made (Save to project), or any binary write: the worker sends it to
  // the app in chunks.
  z.strictObject({
    type: z.literal('chat-write-binary'),
    path: ChatPath,
    data: BinaryData,
    baseHash: Sha256Hex.optional(),
    trigger: Trigger,
    loopId: LoopId.optional()
  }),
  // A project image, as bytes, to attach to the message.
  z.strictObject({ type: z.literal('chat-read-binary'), path: ChatPath }),
  // `@@DOWNLOAD`, on a click only: the worker never sends one with `trigger: 'auto'`.
  z.strictObject({
    type: z.literal('chat-download'),
    url: DownloadParams.shape.url,
    path: ChatPath,
    baseHash: Sha256Hex.optional()
  }),
  // `@@START`, `@@STOP` and `@@LOGS`.
  z.strictObject({
    type: z.literal('chat-bg-start'),
    argv: RunParams.shape.argv,
    trigger: Trigger,
    loopId: LoopId.optional()
  }),
  z.strictObject({ type: z.literal('chat-bg-stop'), argv: RunParams.shape.argv, trigger: Trigger }),
  z.strictObject({
    type: z.literal('chat-bg-logs'),
    argv: RunParams.shape.argv,
    since: BackgroundLogsParams.shape.since,
    tail: BackgroundLogsParams.shape.tail
  }),
  z.strictObject({ type: z.literal('chat-loop'), report: LoopReport }),
  z.strictObject({ type: z.literal('chat-undo'), opId: OpId }),
  z.strictObject({
    type: z.literal('chat-sent'),
    files: z.array(SentFile).max(MAX_FILES_PER_SEND)
  }),
  z.strictObject({ type: z.literal('card-get'), keys: z.array(BlockKey).max(500) }),
  z.strictObject({ type: z.literal('card-set'), key: BlockKey, record: CardRecord }),

  // Dev builds only: the side panel's "Test read" field. Refused in production.
  z.strictObject({
    type: z.literal('dev-file'),
    request: z.discriminatedUnion('type', [
      z.strictObject({ type: z.literal('tree'), payload: TreeParams }),
      z.strictObject({ type: z.literal('read'), payload: ReadParams }),
      z.strictObject({ type: z.literal('write'), payload: WriteParams }),
      z.strictObject({ type: z.literal('undo'), payload: UndoParams })
    ])
  })
]);
export type WorkerRequest = z.infer<typeof WorkerRequest>;
export type WorkerRequestOf<T extends WorkerRequest['type']> = Extract<WorkerRequest, { type: T }>;

/** The requests a content script on chatgpt.com may make. Everything else is refused. */
export const CONTENT_SCRIPT_REQUESTS: ReadonlySet<WorkerRequest['type']> = new Set([
  'chat-sync',
  'chat-read',
  'chat-stat',
  'chat-delete',
  'chat-rename',
  'chat-gone',
  'chat-move-here',
  'chat-requests',
  'chip-corner',
  'chat-write',
  'chat-undo',
  'chat-sent',
  'card-get',
  'card-set',
  'chat-run',
  'chat-run-cancel',
  'chat-loop',
  'chat-write-binary',
  'chat-read-binary',
  'chat-download',
  'chat-bg-start',
  'chat-bg-stop',
  'chat-bg-logs'
]);

/** The requests only the extension's own pages (the side panel) may make. */
export const EXTENSION_PAGE_REQUESTS: ReadonlySet<WorkerRequest['type']> = new Set([
  'get-status',
  'pair',
  'pair-confirm',
  'pair-cancel',
  'unpair',
  'retry',
  'session-preview',
  'session-start',
  'session-end',
  'reload-tab',
  'get-tree',
  'get-list',
  'context-resend',
  'context-remove',
  'session-move',
  'reveal-request',
  'send-files',
  'loop-control',
  'run-cancel',
  'process-stop',
  'process-logs',
  'process-open',
  'attach-files',
  'page-diagnostics',
  'diagnostics',
  'background-tip-seen',
  'dev-file'
]);

/** One file to attach to the chat's message. */
export const AttachmentFile = z.strictObject({
  /** The file's name only, never a folder. */
  name: z.string().min(1).max(255),
  mime: z.string().max(100),
  data: BinaryData
});
export type AttachmentFile = z.infer<typeof AttachmentFile>;

/** Worker → content script, over `chrome.tabs.sendMessage`. */
export const TabMessage = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('insert-text'), text: z.string().min(1).max(4_000_000) }),
  z.strictObject({
    type: z.literal('session-changed'),
    session: z.enum(['active', 'ended', 'elsewhere']).nullable()
  }),
  // Files changed on disk. Open cards re-read them; `overflow`: re-check every card.
  z.strictObject({
    type: z.literal('files-changed'),
    paths: z.array(z.string().max(4096)).max(500),
    overflow: z.boolean()
  }),
  z.strictObject({ type: z.literal('reveal-request'), id: z.string().max(200) }),
  // The app's mode and allowlist, whenever they or the connection change. Null: not connected.
  z.strictObject({ type: z.literal('bridge-config'), config: BridgeConfig.nullable() }),
  z.strictObject({ type: z.literal('run-output'), runId: RunId, chunk: z.string() }),
  z.strictObject({ type: z.literal('run-exit'), result: RunResult }),
  z.strictObject({
    type: z.literal('loop-control'),
    action: LoopAction
  }),
  z.strictObject({ type: z.literal('diagnose') }),
  // Which conversation the tab shows right now, checked on the spot (`TabLocation`).
  z.strictObject({ type: z.literal('locate') }),
  // Project images for the message, as attachments (Send files → Attach).
  z.strictObject({
    type: z.literal('attach-files'),
    files: z.array(AttachmentFile).min(1).max(MAX_ATTACHMENTS)
  })
]);
export type TabMessage = z.infer<typeof TabMessage>;

/** The content script's answer to `locate`. */
export const TabLocation = z.strictObject({
  conversationId: ConversationId.nullable(),
  layout: LayoutHealth
});
export type TabLocation = z.infer<typeof TabLocation>;

export type InsertResult =
  | { ok: true; method: 'paste' | 'insert-text' | 'textarea'; chars: number }
  | { ok: false; error: 'no-composer' | 'not-inserted' };

/** Attaching files to the message: how many went in, or why none did. */
export type AttachResult =
  | { ok: true; method: 'input' | 'paste' | 'drop'; count: number }
  | { ok: false; error: 'no-composer' | 'not-attached' };

/** Why a file wasn't attached: the app refused it, or it can't go to the chat as an image. */
export type AttachRefusal = FileErrorCode | 'not-an-image' | 'image-too-large' | 'image-unreadable';

/** Send files → Attach. */
export type AttachFilesResult =
  | {
      ok: true;
      attached: string[];
      refused: { path: string; code: AttachRefusal }[];
    }
  | { ok: false; error: SessionError | 'not-attached' };

/**
 * The chat session for one conversation, or the tab waiting for its first message.
 * `elsewhere`: the conversation has an active session, but another tab owns it.
 */
export type SessionState = 'active' | 'ended' | 'elsewhere';

/** `chat-sync`'s reply. */
export interface ChatSyncReply {
  connected: boolean;
  session: SessionState | null;
  /** The app's mode and allowlist while connected. */
  config: BridgeConfig | null;
  /** Where the user last put the page chip. */
  chipCorner: ChipCorner;
}

export type PairResult =
  | { ok: true; fingerprint: string }
  | { ok: false; error: 'app-not-running' | 'invalid_code' | 'failed' | ProtocolAdvice }
  | { ok: false; error: 'locked'; retryAfterMs: number };

/** After the user confirmed the fingerprint in the side panel. */
export type PairConfirmResult =
  { ok: true } | { ok: false; error: 'not-confirmed' | 'expired' | 'app-not-running' };

export type SessionError =
  | 'not-connected'
  | 'no-project'
  | 'no-chat-tab'
  | 'layout-unknown'
  | 'no-composer'
  | 'not-inserted'
  | 'no-session'
  | 'failed';

export type SessionPreview =
  { ok: true; chars: number; total: number; shown: number } | { ok: false; error: SessionError };

export type SessionStartResult = { ok: true; chars: number } | { ok: false; error: SessionError };

/** Send files: text files inserted, images attached. */
export type SendFilesResult =
  | {
      ok: true;
      chars: number;
      sent: string[];
      attached: string[];
      refused: { path: string; code: AttachRefusal }[];
      /** Likely secrets replaced with `[redacted]` in what was inserted. */
      redacted: number;
    }
  | { ok: false; error: SessionError | 'not-attached' };

/** One file in context, as the side panel shows it. */
export const ContextEntry = SentFile.extend({
  /** Changed on disk since it was sent. */
  stale: z.boolean(),
  /** Gone from disk since it was sent. */
  missing: z.boolean()
});
export type ContextEntry = z.infer<typeof ContextEntry>;

export const SessionStateSchema = z.enum(['active', 'ended', 'elsewhere']);

/** What the side panel shows about the chat in the active tab. */
export const ChatPanelState = z.strictObject({
  /** The active tab, if it's a chatgpt.com tab with the content script running. */
  tab: z
    .strictObject({ conversationId: ConversationId.nullable(), layout: LayoutHealth })
    .nullable(),
  session: z
    .strictObject({
      state: SessionStateSchema,
      /** Null while a new chat waits for its first message. */
      conversationId: ConversationId.nullable(),
      startedAt: z.number(),
      /** Files sent to the chat this session, newest last, with whether they changed since. */
      context: z.array(ContextEntry).max(1000),
      applied: z.number().int().nonnegative(),
      pending: z.number().int().nonnegative()
    })
    .nullable(),
  /** The Full auto loop in this tab, as it last reported. */
  loop: LoopReport.nullable(),
  /** READ and RUN cards in this tab still waiting for a click. */
  requests: z.array(PendingRequest).max(100),
  /** How the app watches the project: every change, or only the files in context. */
  watch: z.enum(['watch', 'poll']).nullable()
});
export type ChatPanelState = z.infer<typeof ChatPanelState>;

export type ContextResendResult =
  | {
      ok: true;
      sent: string[];
      refused: { path: string; code: FileErrorCode }[];
      redacted: number;
    }
  | { ok: false; error: SessionError };

/** Pushed to the side panel over its `chrome.runtime` port. */
export const StatusUpdate = z.strictObject({
  type: z.literal('status'),
  status: z.enum(CONNECTION_STATUSES as [ConnectionStatus, ...ConnectionStatus[]]),
  /** The desktop's open project while connected, else null. */
  project: ProjectInfo.nullable(),
  /** The app's mode, allowlist and running command while connected, else null. */
  config: BridgeConfig.nullable(),
  /** A session starting or ending turned Full auto off. Cleared when it's on again. */
  fullAutoOff: z.boolean(),
  /** Full auto runs in a hidden tab and the tip about keeping it awake wasn't dismissed. */
  backgroundTip: z.boolean(),
  chat: ChatPanelState
});
export type StatusUpdate = z.infer<typeof StatusUpdate>;

/**
 * Everything the worker sends the side panel: status, and live command output. The panel
 * checks each message against this, like every other listener in the extension.
 */
export const PanelMessage = z.discriminatedUnion('type', [
  StatusUpdate,
  z.strictObject({ type: z.literal('run-output'), runId: RunId, chunk: z.string() }),
  z.strictObject({ type: z.literal('run-exit'), result: RunResult })
]);
export type PanelMessage = z.infer<typeof PanelMessage>;
export type PanelRunMessage = Exclude<PanelMessage, StatusUpdate>;

/** A file request's outcome, plus the ways it can fail before the desktop answers. */
export type RequestOutcome<T> =
  | FileOutcome<T>
  | {
      ok: false;
      error: {
        code: 'not-connected' | 'timeout' | 'bad-response' | 'no-session';
        message: string;
      };
    };

export const SIDE_PANEL_PORT = 'sidepanel';

/**
 * A chat tab's clock (`content/chat/clock.ts`). Chrome holds a hidden tab's timers back to
 * once a minute after about 5 minutes, so while Full auto runs, the content script's waits
 * and its 1s poll come from the worker's timers over this port instead.
 */
export const CLOCK_PORT = 'bridge-clock';
/** The longest wait the worker times for a tab. Full auto's waits are a few seconds. */
export const MAX_CLOCK_WAIT_MS = 60_000;

/** From the content script on its clock port. */
export const ClockRequest = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('clock-wait'),
    id: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    ms: z.number().int().min(0).max(MAX_CLOCK_WAIT_MS)
  }),
  /** Whether Full auto runs and the tab is hidden; the loop's last report, for a restarted worker. */
  z.strictObject({
    type: z.literal('clock-state'),
    running: z.boolean(),
    hidden: z.boolean(),
    report: LoopReport.nullable()
  }),
  /** The answer to a tick: a message to the worker keeps it running. */
  z.strictObject({ type: z.literal('clock-tock') })
]);
export type ClockRequest = z.infer<typeof ClockRequest>;

/** From the worker on a tab's clock port. */
export const ClockMessage = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('clock-wake'),
    id: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
  }),
  z.strictObject({ type: z.literal('clock-tick') })
]);
export type ClockMessage = z.infer<typeof ClockMessage>;
