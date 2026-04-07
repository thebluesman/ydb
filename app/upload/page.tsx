import { prisma } from '@/lib/prisma'
import { UploadFlow } from './_components/UploadFlow'

export const metadata = {
  title: 'Upload — ydb',
}

export default async function UploadPage() {
  const [accounts, categories] = await Promise.all([
    prisma.account.findMany({ where: { isActive: true }, orderBy: { id: 'asc' } }),
    prisma.category.findMany({ orderBy: { name: 'asc' } }),
  ])

  return (
    <div className="flex-1 px-6 py-10 md:px-10 bg-surface-200">
      <div className="max-w-3xl mx-auto space-y-8">
        <div>
          <h1
            className="text-[26px] font-semibold text-cursor-dark leading-[1.25]"
            style={{ letterSpacing: '-0.325px' }}
          >
            Upload Statement
          </h1>
          <p className="mt-1 text-sm leading-[1.5]" style={{ color: 'var(--tx-secondary)' }}>
            Drop a bank statement (PDF or image) to extract and categorise transactions.
          </p>
        </div>
        <UploadFlow accounts={accounts} categories={categories} />
      </div>
    </div>
  )
}
