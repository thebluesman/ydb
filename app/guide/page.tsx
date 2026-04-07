import { prisma } from '@/lib/prisma'
import { GuideView } from './_components/GuideView'

export const metadata = {
  title: 'Field Guide — ydb',
}

export default async function GuidePage() {
  const setting = await prisma.setting.findFirst({ where: { key: 'baseCurrency' } })
  const currency = setting?.value ?? 'USD'
  return <GuideView currency={currency} />
}
