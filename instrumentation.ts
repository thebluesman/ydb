export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { autoBackupIfNeeded } = await import('./lib/backup')
    try {
      await autoBackupIfNeeded()
    } catch (err) {
      console.error('[ydb] Auto-backup failed:', err)
    }
  }
}
