import { Skeleton } from '@/app/_components/ui'

export default function GuideLoading() {
  return (
    <div className="flex-1 px-6 py-10 md:px-10 bg-surface-200">
      <div className="max-w-4xl mx-auto space-y-6">
        <Skeleton style={{ width: 220, height: 30 }} />
        <Skeleton style={{ width: '100%', height: 90 }} />
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="skeleton-card p-6 space-y-3">
            <Skeleton style={{ width: 180, height: 18 }} />
            <Skeleton style={{ width: '100%', height: 12 }} />
            <Skeleton style={{ width: '90%', height: 12 }} />
            <Skeleton style={{ width: '75%', height: 12 }} />
          </div>
        ))}
      </div>
    </div>
  )
}
