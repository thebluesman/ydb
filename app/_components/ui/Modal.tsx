'use client'

import React from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { X } from 'lucide-react'

export type ModalProps = {
  open: boolean
  onClose: () => void
  title?: React.ReactNode
  children: React.ReactNode
  /** Max content width in px. */
  maxWidth?: number
  /** Extra classes on the content padding wrapper. */
  className?: string
  /** Set false to hide the header close button. */
  showClose?: boolean
}

/**
 * Modal primitive — Radix Dialog. Provides focus trap, Escape handling,
 * aria-modal, overlay click-to-close and shared card styling. Replaces the
 * hand-rolled createPortal modals. Scrim uses --bg-overlay; card uses the
 * overlay-level --shadow-card so it reads as above dropdowns/popovers.
 */
export function Modal({
  open,
  onClose,
  title,
  children,
  maxWidth = 420,
  className = '',
  showClose = true,
}: ModalProps) {
  return (
    <Dialog.Root open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="ui-modal-overlay" />
        <Dialog.Content
          className="ui-modal-content"
          style={{ maxWidth }}
          aria-describedby={undefined}
        >
          <div className={`p-6 ${className}`.trim()}>
            {(title || showClose) && (
              <div className="flex items-center justify-between mb-4">
                <Dialog.Title className="text-base font-semibold" style={{ color: 'var(--tx-primary)' }}>
                  {title}
                </Dialog.Title>
                {showClose && (
                  <Dialog.Close asChild>
                    <button aria-label="Close" style={{ color: 'var(--tx-tertiary)' }}>
                      <X size={16} />
                    </button>
                  </Dialog.Close>
                )}
              </div>
            )}
            {children}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
