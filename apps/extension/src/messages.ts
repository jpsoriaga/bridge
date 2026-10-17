import { z } from 'zod';
import {
  BridgeConfig,
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
  type ConnectionStatus,
  type FileErrorCode,
  type FileOutcome,
  type ProjectInfo
} from '@bridge/shared';

/** A path from the chat. The desktop sandbox decides; this only bounds the size. */
const ChatPath = ReadParams.shape.path;
/** Most files one READ card or one "Send files" may send. */
export const MAX_FILES_PER_SEND = 50;

/**
 * `conversationId:messageId:slot:contentHash`. See `blockKey`. The slot is a diff card's
 * block index, or `read` for the message's READ card.
 */
export const BlockKey = z
  .string()
  .regex(/^[\w-]{1,64}:[\w-]{1,128}:(?:\d{1,4}|read):[0-9a-f]{16}$/);

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
  /** Epoch ms. Records older than 30 days are pruned. */
  updatedAt: z.number().int().nonnegative()
});
export type DiffCardRecord = z.infer<typeof DiffCardRecord>;

/** A READ card: whether its files went into the composer. */
export const ReadCardRecord = z.strictObject({
  card: z.literal('read'),
  state: z.enum(['pending', 'sent']),
  updatedAt: z.number().int().nonnegative()
});
export type ReadCardRecord = z.infer<typeof ReadCardRecord>;

export const CardRecord = z.union([DiffCardRecord, ReadCardRecord]);
export type CardRecord = z.infer<typeof CardRecord>;

const WindowId = z.number().int().nonnegative();

/** The side panel's first message on its port: which window it belongs to. */
export const PanelHello = z.strictObject({ type: z.literal('panel-window'), windowId: WindowId });
export type PanelHello = z.infer<typeof PanelHello>;

export const ConversationId = z.string().regex(/^[A-Za-z0-9-]{8,64}$/);
export const LayoutHealth = z.enum(['ok', 'unknown']);

/** chrome.runtime messages to the service worker, from the side panel or content script. */
export const WorkerRequest = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('get-status') }),
  z.strictObject({ type: z.literal('pair'), code: PairingCode }),
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
  z.strictObject({
    type: z.literal('send-files'),
    windowId: WindowId,
    paths: z.array(ChatPath).min(1).max(MAX_FILES_PER_SEND)
  }),
  // The Full auto loop in the panel's active tab. `continue` adds another step limit's worth.
  z.strictObject({
    type: z.literal('loop-control'),
    windowId: WindowId,
    action: z.enum(['stop', 'resume', 'continue'])
  }),
  // Cancels the command running now, whoever started it.
  z.strictObject({ type: z.literal('run-cancel') }),
  // Dev builds: what the page script sees on the panel's active tab, to fix selectors.
  z.strictObject({ type: z.literal('page-diagnostics'), windowId: WindowId }),

  // Content script on chatgpt.com.
  z.strictObject({
    type: z.literal('chat-sync'),
    conversationId: ConversationId.nullable(),
    layout: LayoutHealth,
    /** The content script just started (a load or reload): any loop it had is gone. */
    start: z.literal(true).optional()
  }),
  z.strictObject({ type: z.literal('chat-read'), path: ChatPath }),
  z.strictObject({
    type: z.literal('chat-write'),
    path: ChatPath,
    content: WriteParams.shape.content,
    baseHash: Sha256Hex.optional(),
    trigger: Trigger,
    loopId: LoopId.optional()
  }),
  z.strictObject({
    type: z.literal('chat-run'),
    argv: RunParams.shape.argv,
    trigger: Trigger,
    loopId: LoopId.optional()
  }),
  z.strictObject({ type: z.literal('chat-run-cancel'), runId: RunId }),
  z.strictObject({ type: z.literal('chat-loop'), report: LoopReport }),
  z.strictObject({ type: z.literal('chat-undo'), opId: OpId }),
  z.strictObject({
    type: z.literal('chat-sent'),
    paths: z.array(ChatPath).max(MAX_FILES_PER_SEND)
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
  'chat-write',
  'chat-undo',
  'chat-sent',
  'card-get',
  'card-set',
  'chat-run',
  'chat-run-cancel',
  'chat-loop'
]);

/** The requests only the extension's own pages (the side panel) may make. */
export const EXTENSION_PAGE_REQUESTS: ReadonlySet<WorkerRequest['type']> = new Set([
  'get-status',
  'pair',
  'unpair',
  'retry',
  'session-preview',
  'session-start',
  'session-end',
  'reload-tab',
  'get-tree',
  'send-files',
  'loop-control',
  'run-cancel',
  'page-diagnostics',
  'dev-file'
]);

/** Worker → content script, over `chrome.tabs.sendMessage`. */
export const TabMessage = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('insert-text'), text: z.string().min(1).max(4_000_000) }),
  z.strictObject({
    type: z.literal('session-changed'),
    session: z.enum(['active', 'ended']).nullable()
  }),
  // The app's mode and allowlist, whenever they or the connection change. Null: not connected.
  z.strictObject({ type: z.literal('bridge-config'), config: BridgeConfig.nullable() }),
  z.strictObject({ type: z.literal('run-output'), runId: RunId, chunk: z.string() }),
  z.strictObject({ type: z.literal('run-exit'), result: RunResult }),
  z.strictObject({
    type: z.literal('loop-control'),
    action: z.enum(['stop', 'resume', 'continue'])
  }),
  z.strictObject({ type: z.literal('diagnose') })
]);
export type TabMessage = z.infer<typeof TabMessage>;

export type InsertResult =
  | { ok: true; method: 'paste' | 'insert-text' | 'textarea'; chars: number }
  | { ok: false; error: 'no-composer' | 'not-inserted' };

/** The chat session for one conversation, or the tab waiting for its first message. */
export type SessionState = 'active' | 'ended';

/** `chat-sync`'s reply. */
export interface ChatSyncReply {
  connected: boolean;
  session: SessionState | null;
  /** The app's mode and allowlist while connected. */
  config: BridgeConfig | null;
}

export type PairResult =
  | { ok: true }
  | { ok: false; error: 'app-not-running' | 'invalid_code' | 'failed' }
  | { ok: false; error: 'locked'; retryAfterMs: number };

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

export type SendFilesResult =
  | { ok: true; chars: number; sent: string[]; refused: { path: string; code: FileErrorCode }[] }
  | { ok: false; error: SessionError };

/** What the side panel shows about the chat in the active tab. */
export interface ChatPanelState {
  /** The active tab, if it's a chatgpt.com tab with the content script running. */
  tab: { conversationId: string | null; layout: z.infer<typeof LayoutHealth> } | null;
  session: {
    state: SessionState;
    /** Null while a new chat waits for its first message. */
    conversationId: string | null;
    startedAt: number;
    filesSent: string[];
    applied: number;
    pending: number;
  } | null;
  /** The Full auto loop in this tab, as it last reported. */
  loop: LoopReport | null;
}

/** Pushed to the side panel over its `chrome.runtime` port. */
export interface StatusUpdate {
  type: 'status';
  status: ConnectionStatus;
  /** The desktop's open project while connected, else null. */
  project: ProjectInfo | null;
  /** The app's mode, allowlist and running command while connected, else null. */
  config: BridgeConfig | null;
  chat: ChatPanelState;
}

/** Live command output for the side panel, over the same port. */
export type PanelRunMessage =
  { type: 'run-output'; runId: string; chunk: string } | { type: 'run-exit'; result: RunResult };

export type PanelMessage = StatusUpdate | PanelRunMessage;

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
