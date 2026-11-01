/**
 * CodeBuddy's account, catalog, login and warm sessions.
 *
 * The SDK is the CodeBuddy Code SDK (`@tencent-ai/agent-sdk`). It bundles its
 * own CLI, so unlike the Qoder brands there is no global install and no batch
 * helper: login is an SDK call whose region is `external` (international) or
 * `internal` (mainland). Enterprise/IOA/self-hosted login is out of scope.
 *
 * One CodeBuddy provider serves both regions; the region is a setting, so the
 * models and account shown always belong to the selected login.
 *
 * @module dsh-agent-sdk-bridge/codebuddy
 */
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import type { RawLanguageModel } from '@tencent-ai/agent-sdk';
import type { CodeBuddyRegion } from './brand.ts';
import { CodeBuddyStateStore } from './codebuddy-state.ts';
import type { Live } from './live.ts';
import type { ChannelContent } from './session.ts';
/** Default context capacity assumed for a CodeBuddy model that declares none. */
export declare const CODEBUDDY_DEFAULT_CONTEXT_WINDOW = 200000;
/** Default output cap when the catalog declares none. */
export declare const CODEBUDDY_DEFAULT_MAX_TOKENS = 32000;
/** How long one CodeBuddy account/catalog read stays fresh. */
export declare const CODEBUDDY_CACHE_TTL_MS = 300000;
/** Give up on one CodeBuddy control round trip after this long. */
export declare const CODEBUDDY_FETCH_TIMEOUT_MS = 30000;
/** One model as the settings page and the adapter see it. */
export interface CodeBuddyModel {
    id: string;
    name: string;
    description?: string;
    maxInputTokens?: number;
    maxOutputTokens?: number;
    /**
     * Context budgets the provider actually accepts for this model.
     *
     * Empty means the model exposes no selectable window: CodeBuddy validates
     * `set_config.contextWindow` against `contextWindow.supportedLengths` and
     * rejects everything else with `Allowed: <none>`, so the settings page must
     * not offer a choice the CLI will refuse.
     */
    contextWindows: number[];
    /** The window the model actually runs with (its physical input limit). */
    defaultContextWindow: number;
    vision: boolean;
    reasoningEfforts?: string[];
    defaultEffort?: string;
    /** Credit multiplier, parsed from the catalog's `x0.79 credits` string. */
    priceFactor?: number;
}
/** One signed-in CodeBuddy account. */
export interface CodeBuddyAccount {
    uid?: string;
    userId?: string;
    userName?: string;
    email?: string;
    organization?: string;
    subscriptionType?: string;
}
/** One credit package inside a CodeBuddy quota reading. */
export interface CodeBuddyQuotaPackage {
    name: string;
    total: number;
    used: number;
    /** Epoch milliseconds, when the package expires. */
    end?: number;
}
/** Account credits, read from CodeBuddy's billing endpoint. */
export interface CodeBuddyQuota {
    remaining: number;
    total: number;
    used: number;
    /** Earliest still-valid package expiry, in epoch milliseconds. */
    cycleEnd?: number;
    packages: CodeBuddyQuotaPackage[];
}
/** The account reading served to the settings page. */
export interface CodeBuddyUsageSnapshot {
    at: number;
    account?: CodeBuddyAccount;
    quota?: CodeBuddyQuota;
    /** Why the quota lookup failed, when the account itself was readable. */
    quotaError?: string;
    error?: string;
}
/** Persisted per-region login and account snapshots. */
export declare const codeBuddyState: CodeBuddyStateStore;
/** Login progress for one region. */
export interface CodeBuddyAuthStatus {
    running: boolean;
    region: CodeBuddyRegion;
    startedAt?: number;
    finishedAt?: number;
    /** Browser URL, once the CLI hands one over. */
    url?: string;
    user?: {
        userId: string;
        userName: string;
        userNickname: string;
    };
    /** Whether a usable credential is available for this region. */
    signedIn?: boolean;
    error?: string;
}
/** Turn one raw catalog entry into the model row this plugin uses. */
export declare function toCodeBuddyModel(model: RawLanguageModel): CodeBuddyModel;
/**
 * The account's model catalog for one region.
 *
 * CodeBuddy only answers this after the CLI has started, so the read costs one
 * process boot. Results are cached per region and fall back to the last good
 * list when a refresh fails.
 */
export declare class CodeBuddyCatalog {
    private readonly region;
    private readonly ttlMs;
    private readonly timeoutMs;
    private readonly snapshots;
    private readonly inflight;
    private readonly failures;
    constructor(region: Live<CodeBuddyRegion>, ttlMs?: Live<number>, timeoutMs?: Live<number>);
    /**
     * The last catalog read for a region, without fetching.
     *
     * Callers that must answer synchronously (deciding whether a model exposes a
     * context-budget choice) use this instead of awaiting a refresh.
     */
    snapshot(requested?: CodeBuddyRegion): readonly CodeBuddyModel[] | undefined;
    /** Models for one region; a failed refresh keeps the last good list. */
    models(requested?: CodeBuddyRegion): Promise<readonly CodeBuddyModel[]>;
    /** Why the last refresh failed, or undefined when it succeeded. */
    error(requested?: CodeBuddyRegion): string | undefined;
    invalidate(region?: CodeBuddyRegion): void;
    private fetch;
}
/** Read the signed-in account once per TTL. */
export declare class CodeBuddyAccountReader {
    private readonly region;
    private readonly ttlMs;
    private readonly timeoutMs;
    private readonly cached;
    private readonly inflight;
    constructor(region: Live<CodeBuddyRegion>, ttlMs?: Live<number>, timeoutMs?: Live<number>);
    /**
     * The account for one region.
     *
     * A non-fresh read answers from the persisted snapshot first, so switching
     * the region selector paints immediately; the page follows with `fresh=1`
     * to replace it with a live CLI reading.
     */
    read(fresh?: boolean, requested?: CodeBuddyRegion): Promise<CodeBuddyUsageSnapshot>;
    invalidate(region?: CodeBuddyRegion): void;
    private fetch;
}
/** Turn a raw SDK failure into a sentence the settings page can act on. */
export declare function authErrorText(region: CodeBuddyRegion, error: unknown): string;
/**
 * The account's credits, read from CodeBuddy's billing endpoint.
 *
 * The SDK exposes no quota call, but the CLI's own account page uses
 * `POST /v2/billing/meter/get-user-resource` on the same host. The response is
 * a list of independently expiring credit packages; `CycleCapacity*Precise`
 * is the live balance, while the top-level `TotalDosage` is a stale
 * period-scoped figure and is deliberately ignored.
 *
 * @param payload - the endpoint's JSON answer.
 */
export declare function parseCodeBuddyQuota(payload: unknown): CodeBuddyQuota;
/** Query the billing endpoint once. */
export declare function fetchCodeBuddyQuota(region: CodeBuddyRegion, token: string, fetchImpl?: typeof fetch): Promise<CodeBuddyQuota>;
/**
 * Browser login/logout per region.
 *
 * The SDK owns the browser flow: it emits a URL, waits for the CLI to report
 * the result, and stores the credential where the CLI reads it. This manager
 * only remembers progress so the settings page can poll it.
 */
export declare class CodeBuddyAuth {
    private readonly runs;
    /** Start a login; refuses while the same region is already logging in. */
    start(region: CodeBuddyRegion, onFinish?: (ok: boolean) => void): {
        started: true;
    } | {
        started: false;
        error: string;
    };
    status(region: CodeBuddyRegion): CodeBuddyAuthStatus;
    /** Clear the cached credential for one region. */
    logout(region: CodeBuddyRegion): Promise<{
        ok: true;
    } | {
        ok: false;
        error: string;
    }>;
    /** False once this run was replaced or cancelled by logout. */
    private current;
    private login;
}
/**
 * One warm CodeBuddy session for a host session id.
 *
 * Mirrors the Qoder session's shape: the host's tool calls are exposed through
 * an in-process MCP server; each handler parks until the host delivers that
 * round's results on its next request. The inner CLI keeps the conversation,
 * so a continuation carries only new user text.
 */
export declare class CodeBuddySession {
    readonly sessionId: string;
    private session;
    private mcp;
    private readonly pairing;
    private readonly registered;
    private toolSchemas;
    private queue;
    private disposed;
    private abortPending;
    private turnEndKind;
    private blockIndex;
    private textBlock;
    private reasoningBlock;
    private tools;
    private openTool;
    private callCounter;
    private readonly callNonce;
    private lastUsage;
    /**
     * The last prompt-side buckets a request actually measured.
     *
     * Kept across turns: a turn can end without a usable usage frame (aborted
     * before the first delta, or a transport that only sends the cumulative
     * result). Reusing the last real reading keeps the host's context pressure
     * at the provider's actual prompt instead of collapsing it to the CLI's
     * startup overhead.
     */
    private lastPromptUsage;
    /**
     * Ids of assistant messages whose streaming events this session consumed.
     *
     * Kept across turns, not reset with the turn: the echo of a tool round is
     * delivered on the next stream(), so the previous turn's id is exactly the
     * one that has to be recognised. Only the last few ids matter, and bounding
     * the list keeps a long-lived session from growing without limit.
     */
    private readonly streamedMessageIds;
    private readonly streamedMessageOrder;
    private readonly output;
    private inputChars;
    private readonly toolResultTimeoutMs;
    private readonly abortGraceMs;
    private region;
    private model;
    private effort;
    private systemPrompt;
    private cwd;
    /** Context budget the host shows for this session, when a model offers one. */
    private contextWindow;
    /** Budget already pushed to the CLI, keyed by model and value. */
    private appliedWindow;
    /** Host messages already fed to the inner session, for continuation planning. */
    fedMessages: readonly import('@deepseek-ai/dsh-llm').RequestMessage[] | undefined;
    /** Host system prompt last applied; informational for the adapter. */
    fedSystem: string | undefined;
    constructor(sessionId: string, initialModel: string, runtime?: {
        toolResultTimeoutMs?: Live<number>;
        abortGraceMs?: Live<number>;
    });
    /** Point the session at a region, model and optional system prompt. */
    configure(region: CodeBuddyRegion, model: string, options?: {
        effort?: string;
        system?: string;
        cwd?: string;
        contextWindow?: number;
    }): void;
    /**
     * Push the host-visible context window into the inner session.
     *
     * The CLI resolves its own budget (`override > model default > physical
     * limit`) and both its compaction trigger and the upstream gateway enforce
     * that budget. A global-catalog model such as `deepseek-v4.1-flash` declares
     * `supportedLengths [300K, 1M]` with a 300K default, so a session left alone
     * compacts (and the gateway rejects) anything past 276K — while the host,
     * told 1M, keeps showing and feeding a larger history. Replaying that history
     * then collapses to a summary. Applying the same number the host divides by
     * keeps the two in step; the adapter therefore sends a window for every model
     * it knows about, not only the ones that advertise a choice — the mainland
     * catalog declares no lengths anywhere and its physical `maxInputTokens` is a
     * provider number the CLI is free to ignore when left to itself.
     *
     * A rejected value keeps the CLI on its own default, which is the one case
     * where the two denominators can still disagree; it is reported nowhere, so
     * the host's figure stays the visible contract.
     */
    private applyContextWindow;
    /**
     * Remember the host tools and register them with this session's MCP server.
     *
     * Registration must happen before the CLI connects: the MCP SDK refuses a
     * tool added afterwards. The first turn calls this before the session — and
     * therefore its MCP server — exists, so the schemas are kept and replayed by
     * {@link ensureStarted}. Returning early there left the model with no host
     * tools at all, and it fell back to CodeBuddy's built-in `Bash`, which the
     * host could only answer with "unknown tool".
     */
    ensureTools(tools: readonly {
        name: string;
        description: string;
        parameters?: unknown;
    }[]): void;
    private registerTools;
    /** Hand the host's tool results to parked or buffered handlers. */
    deliverToolResults(tail: readonly {
        role: string;
        toolCallId?: unknown;
        content?: unknown;
        isError?: boolean;
    }[]): void;
    /** Run one host turn; `feed` is new user content, or null for a tool continuation. */
    stream(options: GenerateOptions, feed: string | ChannelContent[] | null): AsyncGenerator<StreamChunk>;
    /** Tear the inner CLI down; parked handlers settle with a cancellation. */
    close(): void;
    private ensureStarted;
    private canUseTool;
    private consume;
    private handle;
    /** Record that one assistant message reached the host as streaming events. */
    private rememberStreamedMessage;
    private resetTurnState;
    private emit;
    private countOutput;
    private usage;
    private endTurn;
}
/**
 * Warm sessions keyed by host session id. A region change retires the old
 * session rather than mutating one, because the CLI process was started with
 * the previous region's endpoint.
 */
export declare class CodeBuddySessionManager {
    readonly maxSessions: Live<number>;
    private readonly runtime;
    private readonly sessions;
    constructor(maxSessions: Live<number>, runtime?: {
        toolResultTimeoutMs?: Live<number>;
        abortGraceMs?: Live<number>;
    });
    forSession(sessionId: string, region: CodeBuddyRegion, model: string): CodeBuddySession;
    dispose(sessionId: string): void;
    closeAll(): void;
}
/** A one-shot turn, used for titles and compaction summaries. */
export declare function codeBuddyColdStream(region: CodeBuddyRegion, prompt: string, model: string | undefined, options: GenerateOptions): Promise<StreamChunk[]>;
