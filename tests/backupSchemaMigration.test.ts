import { describe, expect, it, vi } from 'vitest'
import { bringSchemaCurrent, type PrismaRunner } from '@/lib/backup'

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
  return { ...actual, spawnSync: vi.fn() }
})

// ─────────────────────────────────────────────────────────────────────────────
// Regression test for the backup-restore schema reconciliation (Phase 7 item 3).
//
// Restoring a snapshot older than the newest applied migration used to leave
// dev.db missing recent columns, which 500s the app (P2022 "column does not
// exist"). restoreBackup() now runs bringSchemaCurrent() after swapping the
// file in. That helper's job is to pick the right prisma invocation:
//
//   - `migrate deploy` when the snapshot carries migration history (common
//     case; keeps history intact),
//   - fall back to `db push` when migrate deploy refuses (P3005 — a
//     pre-baseline snapshot with no _prisma_migrations table),
//   - throw when neither can reconcile, so the caller rolls the restore back.
//
// The real prisma CLI behaviour behind each branch is exercised by hand
// (see the commit message); here we lock in the branch *selection* with an
// injected runner so it stays fast and deterministic.
// ─────────────────────────────────────────────────────────────────────────────

function recordingRunner(
  outcomes: Record<string, { status: number; output?: string }>,
): { runner: PrismaRunner; calls: string[] } {
  const calls: string[] = []
  const runner: PrismaRunner = (args) => {
    const key = args.slice(0, 2).join(' ')
    calls.push(key)
    const o = outcomes[key] ?? { status: 1, output: `unexpected: ${key}` }
    return { status: o.status, output: o.output ?? '' }
  }
  return { runner, calls }
}

describe('bringSchemaCurrent', () => {
  it('uses migrate deploy when it succeeds and never touches db push', () => {
    const { runner, calls } = recordingRunner({ 'migrate deploy': { status: 0 } })
    expect(bringSchemaCurrent({ runner })).toEqual({ method: 'migrate-deploy' })
    expect(calls).toEqual(['migrate deploy'])
  })

  it('falls back to db push when migrate deploy fails (e.g. P3005 pre-baseline snapshot)', () => {
    const { runner, calls } = recordingRunner({
      'migrate deploy': { status: 1, output: 'P3005 database schema is not empty' },
      'db push': { status: 0 },
    })
    expect(bringSchemaCurrent({ runner })).toEqual({ method: 'db-push' })
    expect(calls).toEqual(['migrate deploy', 'db push'])
  })

  it('throws with both diagnostics when neither path can reconcile the schema', () => {
    const { runner } = recordingRunner({
      'migrate deploy': { status: 1, output: 'deploy boom' },
      'db push': { status: 1, output: 'push boom' },
    })
    expect(() => bringSchemaCurrent({ runner })).toThrow(/deploy boom[\s\S]*push boom/)
  })
})

// Review fix on PR #20: the default runner shells out via `spawnSync` with no
// timeout, so a hung/lock-blocked `migrate deploy`/`db push` could freeze the
// whole (single-threaded) process indefinitely. Lock in that a finite timeout
// is actually passed through when no injected runner is supplied.
describe('defaultPrismaRunner (no injected runner)', () => {
  it('calls spawnSync with a finite timeout', async () => {
    const { spawnSync } = await import('node:child_process')
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: '',
      stderr: '',
      pid: 0,
      output: [],
      signal: null,
    } as unknown as ReturnType<typeof spawnSync>)

    bringSchemaCurrent()

    expect(spawnSync).toHaveBeenCalled()
    const [, , options] = vi.mocked(spawnSync).mock.calls[0]
    expect(options?.timeout).toBeGreaterThan(0)
    expect(Number.isFinite(options?.timeout)).toBe(true)
  })
})
