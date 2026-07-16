import { Skeleton } from '@/app/_components/ui'

export default function UploadLoading() {
  return (
    <div className="flex-1 px-6 py-10 md:px-10 bg-surface-200">
      <div className="max-w-6xl mx-auto space-y-8">
        <div className="space-y-2">
          <Skeleton style={{ width: 200, height: 30 }} />
          <Skeleton style={{ width: 360, height: 14 }} />
        </div>
        <div className="space-y-4">
          <div className="skeleton-card p-6 space-y-3">
            <Skeleton style={{ width: 70, height: 11 }} />
            <div className="flex gap-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} style={{ width: 120, height: 32, borderRadius: 999 }} />
              ))}
            </div>
          </div>
          <div className="skeleton-card p-6 space-y-4">
            <Skeleton style={{ width: 110, height: 11 }} />
            <Skeleton style={{ width: '100%', height: 160 }} />
            <Skeleton style={{ width: '100%', height: 40 }} />
          </div>
        </div>
      </div>
    </div>
  )
}
