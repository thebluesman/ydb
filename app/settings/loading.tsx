import { Skeleton } from '@/app/_components/ui'

export default function SettingsLoading() {
  return (
    <div className="flex-1 px-6 py-10 md:px-10 bg-surface-200">
      <div className="max-w-2xl mx-auto space-y-8">
        <div className="space-y-2">
          <Skeleton style={{ width: 140, height: 30 }} />
          <Skeleton style={{ width: 300, height: 14 }} />
        </div>
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="skeleton-card p-6 space-y-4">
            <Skeleton style={{ width: 160, height: 20 }} />
            <Skeleton style={{ width: 240, height: 12 }} />
            <Skeleton style={{ width: '100%', height: 80 }} />
          </div>
        ))}
      </div>
    </div>
  )
}
