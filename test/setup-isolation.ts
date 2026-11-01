/**
 * Redirect CodeBuddy's on-disk state into a throwaway directory for every test
 * file.
 *
 * The store is a module-level singleton, so importing `src/codebuddy.ts` at all
 * puts the real `~/.dsh/agent-sdk-bridge/codebuddy-state.json` one property read
 * away — and that file holds a live bearer credential. Reading it is harmless;
 * writing it is not: the recovery added for the "signed in but shown signed
 * out" bug rewrites the file the first time it loads a legacy shape, so a test
 * that only meant to check a model row could silently repair, or after a failed
 * quota read *drop*, the credential of the machine running the tests.
 *
 * Per-file env assignment cannot fix this structurally — the files that import
 * the adapter for its pure helpers never touch CodeBuddy state and so never set
 * a path. Vitest runs setup files before importing the test module, so this is
 * the one place that covers every case.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll } from 'vitest'

const root = mkdtempSync(join(tmpdir(), 'dsh-codebuddy-test-'))
process.env.DSH_CODUBUDDY_STATE_PATH = join(root, 'codebuddy-state.json')
process.env.DSH_CODUBUDDY_CLI_DIR = join(root, 'codebuddy-cli')

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})
