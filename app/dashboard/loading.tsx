import { Skeleton } from '@/app/_components/ui'

export default function DashboardLoading() {
  return (
    <div className="flex-1 px-6 py-10 md:px-10 bg-surface-200">
      <div className="max-w-6xl mx-auto space-y-8">
        <div className="space-y-2">
          <Skeleton style={{ width: 180, height: 30 }} />
          <Skeleton style={{ width: 260, height: 14 }} />
        </div>
        {/* Summary stat cards */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="skeleton-card p-5 space-y-3">
              <Skeleton style={{ width: 90, height: 11 }} />
              <Skeleton style={{ width: 130, height: 24 }} />
            </div>
          ))}
        </div>
        {/* Chart placeholders */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {Array.from({ length: 2 }).map((_, i) => (
            <div key={i} className="skeleton-card p-6 space-y-4">
              <Skeleton style={{ width: 150, height: 16 }} />
              <Skeleton style={{ width: '100%', height: 220 }} />
            </div>
          ))}
        </div>
        <div className="skeleton-card p-6 space-y-4">
          <Skeleton style={{ width: 150, height: 16 }} />
          <Skeleton style={{ width: '100%', height: 260 }} />
        </div>
      </div>
    </div>
  )
}
