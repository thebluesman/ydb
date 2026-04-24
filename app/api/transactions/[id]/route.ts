import { prisma } from '@/lib/prisma'
import { NextResponse } from 'next/server'
import { validateTransactionWrite } from '@/lib/transactionValidation'

const INCLUDE = {
  account: { select: { name: true, currency: true } },
  splitLegs: { select: { id: true, amount: true, category: true, description: true } },
  reimbursementTx: { select: { id: true, amount: true, description: true } },
  reimbursedExpense: { select: { id: true, description: true } },
  transferCounterpartAccount: { select: { id: true, name: true } },
} as const

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const txId = parseInt(id)
  if (isNaN(txId)) {
    return NextResponse.json({ error: 'Invalid id' }, { status: 400 })
  }
  const body = await request.json()

  // Snapshot the row first so we know whether it's a linked transfer and
  // whether we need to mirror the edit to its counterpart.
  const existing = await prisma.transaction.findUnique({ where: { id: txId } })
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // Validate the merged state — whatever the row will be after applying the
  // patch must obey sign/type and transfer rules.
  const onlyValidationFieldsChanged =
    body.amount !== undefined ||
    body.transactionType !== undefined ||
    body.accountId !== undefined ||
    body.transferCounterpartAccountId !== undefined
  if (onlyValidationFieldsChanged) {
    const merged = {
      transactionType: body.transactionType ?? existing.transactionType,
      amount: body.amount ?? existing.amount,
      accountId: body.accountId ?? existing.accountId,
      transferCounterpartAccountId:
        body.transferCounterpartAccountId !== undefined
          ? body.transferCounterpartAccountId
          : existing.transferCounterpartAccountId,
    }
    // Allow one-sided transfers on edit (legacy imports may be one-sided).
    const invalid = await validateTransactionWrite(merged, { allowOneSidedTransfer: true })
    if (invalid) return NextResponse.json(invalid, { status: 400 })
  }

  const updateData = {
    ...(body.date !== undefined && { date: new Date(body.date) }),
    ...(body.amount !== undefined && { amount: body.amount }),
    ...(body.description !== undefined && { description: body.description }),
    ...(body.originalDescription !== undefined && { originalDescription: body.originalDescription }),
    ...(body.transactionType !== undefined && { transactionType: body.transactionType }),
    ...(body.category !== undefined && { category: body.category }),
    ...(body.accountId !== undefined && { accountId: body.accountId }),
    ...(body.status !== undefined && { status: body.status }),
    ...(body.notes !== undefined && { notes: body.notes ?? null }),
    ...(body.reimbursableFor !== undefined && { reimbursableFor: body.reimbursableFor }),
    ...(body.transferCounterpartAccountId !== undefined && { transferCounterpartAccountId: body.transferCounterpartAccountId }),
  }

  // Re-pair the counterpart if the user moved the transfer to a different
  // account on either side. Without this, editing accountId on a linked
  // transfer orphans the old counterpart on its old account (the pair points
  // at each other but the balances no longer match).
  const accountChanged =
    body.accountId !== undefined && body.accountId !== existing.accountId
  const counterpartTargetChanged =
    body.transferCounterpartAccountId !== undefined &&
    body.transferCounterpartAccountId !== existing.transferCounterpartAccountId
  const needsRepair =
    existing.linkedTransferId !== null &&
    (accountChanged || counterpartTargetChanged)

  await prisma.$transaction(async (tx) => {
    if (needsRepair && existing.linkedTransferId !== null) {
      const old = await tx.transaction.findUnique({ where: { id: existing.linkedTransferId } })
      if (!old) throw new Error('linked counterpart not found')

      // Resolve the new counterpart account id. Prefer an explicit
      // transferCounterpartAccountId override, otherwise keep the old target
      // (the user only changed their own side).
      const newCounterpartAccountId =
        body.transferCounterpartAccountId !== undefined
          ? body.transferCounterpartAccountId
          : old.accountId
      if (newCounterpartAccountId == null) {
        throw new Error('cannot re-pair: no counterpart account id')
      }
      const newOwnAccountId = body.accountId ?? existing.accountId
      if (newOwnAccountId === newCounterpartAccountId) {
        throw new Error('source and counterpart account must differ')
      }

      // Drop the back-pointer so we can safely delete the old counterpart.
      await tx.transaction.update({
        where: { id: existing.linkedTransferId },
        data: { linkedTransferId: null },
      })
      await tx.transaction.delete({ where: { id: existing.linkedTransferId } })

      // Apply the user's own-side patch first.
      await tx.transaction.update({
        where: { id: txId },
        data: {
          ...updateData,
          transferCounterpartAccountId: newCounterpartAccountId,
          linkedTransferId: null,
        },
      })

      // Create a fresh counterpart on the new target account mirroring the
      // shared fields. Amount gets the opposite sign; the two sides' accountIds
      // reference each other as transferCounterpartAccountId.
      const mirroredAmount = -(body.amount !== undefined ? body.amount : existing.amount)
      const created = await tx.transaction.create({
        data: {
          date: new Date(body.date !== undefined ? body.date : existing.date),
          amount: mirroredAmount,
          description: body.description !== undefined ? body.description : existing.description,
          transactionType: 'transfer',
          category: body.category !== undefined ? body.category : existing.category,
          accountId: newCounterpartAccountId,
          status: body.status !== undefined ? body.status : existing.status,
          notes: body.notes !== undefined ? (body.notes ?? null) : existing.notes,
          transferCounterpartAccountId: newOwnAccountId,
          linkedTransferId: txId,
        },
      })
      await tx.transaction.update({
        where: { id: txId },
        data: { linkedTransferId: created.id },
      })
    } else {
      await tx.transaction.update({ where: { id: txId }, data: updateData })

      // Mirror shared attributes to the paired row so the two sides of a
      // transfer stay in sync. amount gets the opposite sign; accountId /
      // transferCounterpartAccountId are NOT mirrored on this path — a
      // re-pair handled by the branch above takes care of account changes.
      if (existing.linkedTransferId) {
        const mirror: Record<string, unknown> = {}
        if (body.date !== undefined) mirror.date = new Date(body.date)
        if (body.amount !== undefined) mirror.amount = -body.amount
        if (body.description !== undefined) mirror.description = body.description
        if (body.status !== undefined) mirror.status = body.status
        if (body.notes !== undefined) mirror.notes = body.notes ?? null
        if (Object.keys(mirror).length > 0) {
          await tx.transaction.update({
            where: { id: existing.linkedTransferId },
            data: mirror,
          })
        }
      }
    }
  })

  const updated = await prisma.transaction.findUnique({
    where: { id: txId },
    include: INCLUDE,
  })
  return NextResponse.json(updated)
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const txId = parseInt(id)
  if (isNaN(txId)) {
    return NextResponse.json({ error: 'Invalid id' }, { status: 400 })
  }

  // Read first so we know what else to clean up. Without this, deleting a
  // split parent FK-errors (legs reference it) and deleting one side of a
  // linked transfer leaves an orphan row with a stale linkedTransferId.
  const existing = await prisma.transaction.findUnique({
    where: { id: txId },
    include: { splitLegs: { select: { id: true } } },
  })
  if (!existing) return NextResponse.json({ ok: true })

  await prisma.$transaction(async (tx) => {
    // Null out the back-pointer first so the second update in a linked pair
    // doesn't FK-reference a row that's about to be deleted.
    if (existing.linkedTransferId) {
      await tx.transaction.update({
        where: { id: existing.linkedTransferId },
        data: { linkedTransferId: null },
      })
    }
    // Split legs are owned by the parent; cascade.
    if (existing.splitLegs.length > 0) {
      await tx.transaction.deleteMany({ where: { parentTransactionId: txId } })
    }
    await tx.transaction.delete({ where: { id: txId } })
    if (existing.linkedTransferId) {
      await tx.transaction.delete({ where: { id: existing.linkedTransferId } })
    }
  })

  return NextResponse.json({ ok: true })
}
