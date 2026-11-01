/**
 * CodeBuddy's two login regions must not see each other's state, and a live
 * login must never be reported as signed out.
 *
 * Three properties that were each broken before:
 *
 * - Region scope on the *auth* calls. Sessions carried `CODEBUDDY_CONFIG_DIR`
 *   and so read the right catalog, but `authenticate`, `logout` and the silent
 *   token read passed only `environment` — which put every login in the CLI's
 *   shared default directory. Signing into one region therefore overwrote the
 *   other, and logging one out left the page's region untouched.
 * - Expiry must be known, not guessed. The old matcher tested the error *text*
 *   against `/401|403|…|token/i`, so an HTML error page mentioning a token, or
 *   any number containing 401, dropped a working credential. Nothing then read
 *   as signed in, because a missing local token used to be treated as proof of
 *   a signed-out region rather than as something to re-check.
 * - One credential per region on disk. The CLI's `accountInfo()` answer carries
 *   a bearer token beside the identity, and that object used to be persisted
 *   whole and handed to the settings page.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fake = vi.hoisted(() => ({
  authCalls: [] as Record<string, unknown>[],
  authFails: false,
  account: { uid: 'u-1', userName: 'dev', userNickname: 'dev', token: 'embedded-token' } as Record<string, unknown>,
}))

vi.mock('../src/sdk.ts', () => ({
  codeBuddyEnvironment: (region: string) => region === 'cn' ? 'internal' : 'external',
  loadCodeBuddySdk: async () => ({
    unstable_v2_logout: async (options: Record<string, unknown>) => {
      fake.authCalls.push({ method: 'logout', ...options })
    },
    unstable_v2_authenticate: async (options: { onAuthUrl: (state: { authUrl: string }) => void }) => {
      fake.authCalls.push({ method: 'authenticate', ...options })
      if (fake.authFails) throw new Error('Authentication failed')
      options.onAuthUrl({ authUrl: 'https://codebuddy.example/login' })
      return { userinfo: { userId: 'u-1', userName: 'dev', userNickname: 'dev', token: 'fresh-token' } }
    },
    query: () => ({
      connect: async () => {},
      accountInfo: async () => ({ ...fake.account }),
      return: async () => {},
    }),
    unstable_v2_createSession: () => ({ connect: async () => {}, close: () => {} }),
    createSdkMcpServer: () => ({ instance: { registerTool: () => {} } }),
  }),
}))

const root = mkdtempSync(join(tmpdir(), 'codebuddy-isolation-'))
const statePath = join(root, 'state.json')
process.env.DSH_CODUBUDDY_CLI_DIR = root
process.env.DSH_CODUBUDDY_STATE_PATH = statePath

const { CodeBuddyAccountReader, CodeBuddyAuth, codeBuddyState } = await import('../src/codebuddy.ts')
const { CodeBuddyStateStore } = await import('../src/codebuddy-state.ts')

afterEach(() => {
  vi.unstubAllGlobals()
  fake.authCalls.length = 0
  fake.authFails = false
  fake.account = { uid: 'u-1', userName: 'dev', userNickname: 'dev', token: 'embedded-token' }
})

describe('region scope on the auth calls', () => {
  // Signed out at the start of every case, so nothing is adopted from an
  // earlier test's remembered token.
  beforeEach(() => { codeBuddyState.clear('cn'); codeBuddyState.clear('global') })

  it('logs in and out inside one region directory, and not the other', async () => {
    const auth = new CodeBuddyAuth()
    await new Promise<void>(resolve => { void auth.start('cn', () => resolve()) })
    await auth.logout('cn')

    const dirs = fake.authCalls.map(call => (call.env as Record<string, string>)?.CODEBUDDY_CONFIG_DIR)
    expect(dirs.length).toBeGreaterThan(2)
    // The layout under `DSH_CODUBUDDY_CLI_DIR` is `<root>/<region>`; the last
    // segment is the property that matters — every auth call carries one, and it
    // is the same one for the whole region.
    const leaf = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop()
    for (const dir of dirs) {
      expect(typeof dir).toBe('string')
      expect(leaf(dir!)).toBe('cn')
    }

    fake.authCalls.length = 0
    await new Promise<void>(resolve => { void auth.start('global', () => resolve()) })
    const globalDir = (fake.authCalls[0].env as Record<string, string>).CODEBUDDY_CONFIG_DIR
    expect(leaf(globalDir)).toBe('global')
    expect(globalDir).not.toBe(dirs[0])
  })

  it('does not hand the login flow a stored bearer token', async () => {
    // A login click means "open the browser for this account"; an injected
    // token is the other region's until proven otherwise, and `logout` before
    // the click would then be aiming at a credential the page does not own.
    codeBuddyState.patch('cn', { token: 'stored-1', signedIn: true })
    const auth = new CodeBuddyAuth()
    await new Promise<void>(resolve => { void auth.start('cn', () => resolve()) })
    for (const call of fake.authCalls) {
      expect((call.env as Record<string, string>)?.CODEBUDDY_AUTH_TOKEN).toBeUndefined()
    }
  })
})

describe('quota failure only ends a login when the credential was rejected', () => {
  const reader = new CodeBuddyAccountReader('cn')

  beforeEach(() => {
    codeBuddyState.clear('cn')
    codeBuddyState.patch('cn', { token: 'secret-1', signedIn: true })
  })

  it('keeps the credential when the endpoint fails for another reason', async () => {
    // Exactly the shape that used to be misread as an expiry: a server error
    // page whose text mentions a token.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      '<html>Invalid Token, please refresh the token page</html>',
      { status: 500 },
    )))

    const snapshot = await reader.read(true)
    expect(snapshot.account).toBeDefined()
    expect(snapshot.quotaError).toBeDefined()
    expect(codeBuddyState.token('cn')).toBe('secret-1')
    expect(codeBuddyState.region('cn')?.signedIn).toBe(true)
  })

  it('drops the credential on an explicit rejection', async () => {
    fake.authFails = true
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 401 })))

    const snapshot = await reader.read(true)
    expect(snapshot.quotaError).toBeDefined()
    expect(codeBuddyState.token('cn')).toBeUndefined()
  })

  it('asks the CLI even when no credential is stored', async () => {
    // The page used to answer "尚未登录" here on the strength of the missing
    // local copy alone, so a dropped token was unrecoverable without a fresh
    // browser login even while the CLI still reported the account.
    fake.account = { uid: 'u-9', userName: 'still-in' }
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ data: { Response: { Packages: [] } } }), { status: 200 },
    )))

    const snapshot = await reader.read(true)
    expect(snapshot.error).toBeUndefined()
    expect(snapshot.account?.userName).toBe('still-in')
    expect(codeBuddyState.region('cn')?.signedIn).toBe(true)
  })
})

describe('one credential per region', () => {
  it('never persists the copy carried inside the account object', async () => {
    // The CLI answer above still holds a token, and the reader writes that
    // object to disk for the next page paint.
    codeBuddyState.clear('cn')
    fake.account = { uid: 'u-1', userName: 'dev', token: 'embedded-token' }
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ data: { Response: { Packages: [] } } }), { status: 200 },
    )))
    await new CodeBuddyAccountReader('cn').read(true)

    const onDisk = JSON.parse(readFileSync(statePath, 'utf8'))
    expect(JSON.stringify(onDisk)).not.toContain('embedded-token')
  })

  it('lifts a token that an older version hid inside the account', () => {
    // Files written before the account was cleaned hold a usable credential in
    // `account.token` while `token` itself is gone — which read as signed out,
    // permanently, because nothing looked there.
    const legacy = join(root, 'legacy.json')
    writeFileSync(legacy, JSON.stringify({
      version: 1,
      regions: { cn: { signedIn: false, at: 1, account: { uid: 'u-1', userName: 'dev', token: 'hidden-1' } } },
    }))

    const store = new CodeBuddyStateStore(legacy)
    expect(store.token('cn')).toBe('hidden-1')
    expect(store.signedIn('cn')).toBe(true)

    const recovered = JSON.parse(readFileSync(legacy, 'utf8'))
    expect(recovered.regions.cn.token).toBe('hidden-1')
    expect(recovered.regions.cn.account.token).toBeUndefined()
  })

  it('leaves a region with no credential alone', () => {
    const clean = join(root, 'clean.json')
    writeFileSync(clean, JSON.stringify({ version: 1, regions: { cn: { signedIn: false, account: { uid: 'u-1' } } } }))
    const store = new CodeBuddyStateStore(clean)
    expect(store.token('cn')).toBeUndefined()
    expect(store.signedIn('cn')).toBe(false)
  })
})
