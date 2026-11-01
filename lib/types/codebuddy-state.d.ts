/**
 * CodeBuddy's own per-region snapshot on disk.
 *
 * The SDK's browser login returns a bearer token, but it is only available in
 * the process that ran the login. Saving it here is what lets a later process
 * switch back to a region and use the account immediately instead of opening
 * the browser again. The account and quota reading are saved alongside it so
 * the settings card can paint before a fresh CLI read finishes.
 *
 * The file is per-user, mode 0600, and contains a bearer credential: do not log
 * it or copy it into bug reports.
 *
 * @module dsh-agent-sdk-bridge/codebuddy-state
 */
import type { CodeBuddyRegion } from './brand.ts';
import type { CodeBuddyAccount, CodeBuddyQuota, CodeBuddyUsageSnapshot } from './codebuddy.ts';
/** The signed-in identity remembered for one region. */
export interface CodeBuddySavedUser {
    userId: string;
    userName: string;
    userNickname: string;
}
/**
 * A stored account reading with its credential removed.
 *
 * The CLI's `accountInfo()` answer carries a bearer token, and older versions
 * persisted that object whole — a second copy of the credential in a file that
 * gets backed up and pasted into bug reports, one the plugin never read. A
 * region holds exactly one credential, in `token`.
 */
export declare function withoutCredential(account: CodeBuddyAccount | undefined): CodeBuddyAccount | undefined;
/** Everything remembered for one login region. */
export interface CodeBuddySavedRegion {
    /** Bearer credential from the SDK login, used to restore the login. */
    token?: string;
    user?: CodeBuddySavedUser;
    signedIn?: boolean;
    account?: CodeBuddyAccount;
    quota?: CodeBuddyQuota;
    quotaError?: string;
    /** When the account snapshot was last written. */
    at?: number;
}
/**
 * One CLI user-data directory per login region.
 *
 * The bundled CLI remembers its product environment inside this directory and
 * only switches it during initialize, after the model provider has already
 * chosen a catalog. Two regions sharing the default `~/.codebuddy` therefore
 * read each other's catalogs after a switch, and the wrong list got cached for
 * five minutes. A separate directory fixes the environment per region, so every
 * boot reads its own catalog. `DSH_CODUBUDDY_CLI_DIR` exists for tests.
 */
export declare function codeBuddyCliDir(region: CodeBuddyRegion): string;
/** The per-user file behind {@link CodeBuddyStateStore}. */
export declare class CodeBuddyStateStore {
    private readonly file;
    private loaded;
    private state;
    constructor(file?: string);
    private ensureLoaded;
    /**
     * Lift a credential the old layout hid inside the account object.
     *
     * The CLI's `accountInfo()` answer carries a bearer token of its own, and an
     * earlier version persisted that whole object here. When the top-level
     * `token` was later dropped — which any quota failure used to do, because
     * expiry was *guessed* from the error text — the region read as signed out
     * even though a working credential still sat in the file, and nothing could
     * recover it without a fresh browser login. This picks the copy back up.
     *
     * {@link persist} no longer stores a token inside the account, so this runs
     * only over files written by those older versions.
     */
    private recoverLostTokens;
    region(region: CodeBuddyRegion): CodeBuddySavedRegion | undefined;
    /** The stored bearer token, or undefined when the region is signed out. */
    token(region: CodeBuddyRegion): string | undefined;
    user(region: CodeBuddyRegion): CodeBuddySavedUser | undefined;
    signedIn(region: CodeBuddyRegion): boolean;
    /** The saved account reading, in the shape the usage route returns. */
    usage(region: CodeBuddyRegion): CodeBuddyUsageSnapshot | undefined;
    /** Merge fields into one region and write the file; `undefined` deletes. */
    patch(region: CodeBuddyRegion, patch: Partial<CodeBuddySavedRegion>): void;
    /**
     * Drop only the credential, keeping the last account reading.
     *
     * An expired token must stop being used for sessions, while the card can
     * still show which account expired so the user knows what to sign into.
     */
    clearToken(region: CodeBuddyRegion): void;
    /** Forget one region entirely: logout and expired credentials both land here. */
    clear(region: CodeBuddyRegion): void;
    private persist;
}
