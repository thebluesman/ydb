export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { autoBackupIfNeeded } = await import('./lib/backup')
    try {
      await autoBackupIfNeeded()
    } catch (err) {
      console.error('[ydb] Auto-backup failed:', err)
    }

    // One-off: bring any category colours that aren't from the curated palette
    // onto a palette colour. This used to run as a DB write during the Settings
    // page render; doing it once at startup keeps rendering side-effect-free.
    try {
      const { prisma } = await import('./lib/prisma')
      const { colorForCategory, PALETTE } = await import('./lib/category-colors')
      const categories = await prisma.category.findMany()
      const stale = categories.filter((c) => !PALETTE.includes(c.color))
      if (stale.length > 0) {
        await Promise.all(
          stale.map((c) =>
            prisma.category.update({ where: { id: c.id }, data: { color: colorForCategory(c.name) } }),
          ),
        )
        console.log(`[ydb] Normalised ${stale.length} category colour(s) to the palette`)
      }
    } catch (err) {
      console.error('[ydb] Category colour migration failed:', err)
    }
  }
}
