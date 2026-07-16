import { Skeleton } from '@/app/_components/ui'

export default function LedgerLoading() {
  return (
    <div className="flex-1 px-6 py-10 md:px-10 bg-surface-200">
      <div className="max-w-6xl mx-auto space-y-8">
        <div className="space-y-2">
          <Skeleton style={{ width: 140, height: 30 }} />
          <Skeleton style={{ width: 240, height: 14 }} />
        </div>
        {/* Stat cards */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="skeleton-card p-5 space-y-3">
              <Skeleton style={{ width: 80, height: 11 }} />
              <Skeleton style={{ width: 120, height: 22 }} />
            </div>
          ))}
        </div>
        {/* Filter bar */}
        <div className="flex flex-wrap gap-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} style={{ width: 120, height: 34 }} />
          ))}
        </div>
        {/* Table rows */}
        <div className="skeleton-card p-4 space-y-3">
          {Array.from({ length: 10 }).map((_, i) => (
            <div key={i} className="flex items-center gap-4">
              <Skeleton style={{ width: 90, height: 14 }} />
              <Skeleton style={{ flex: 1, height: 14 }} />
              <Skeleton style={{ width: 80, height: 14 }} />
              <Skeleton style={{ width: 90, height: 14 }} />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
