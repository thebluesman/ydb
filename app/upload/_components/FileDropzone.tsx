'use client'

import { useDropzone } from 'react-dropzone'
import { Upload, FileText, Image } from 'lucide-react'

export function FileDropzone({
  onFile, disabled, file, onClear,
}: {
  onFile: (file: File) => void
  disabled: boolean
  file: File | null
  onClear: () => void
}) {
  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    accept: { 'image/*': [], 'application/pdf': ['.pdf'] },
    maxFiles: 1,
    disabled,
    onDropAccepted: ([f]) => onFile(f),
  })

  if (file) {
    return (
      <div
        className="flex items-center gap-4 px-5 py-4 rounded-[8px]"
        style={{ border: '1px solid var(--border-warm)', backgroundColor: 'var(--bg-card)' }}
      >
        <div>{file.type === 'application/pdf' ? <FileText size={22} style={{ color: 'var(--tx-secondary)' }} /> : <Image size={22} style={{ color: 'var(--tx-secondary)' }} />}</div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium truncate" style={{ color: 'var(--tx-primary)' }}>{file.name}</p>
          <p className="text-xs mt-0.5" style={{ color: 'var(--tx-secondary)' }}>
            {(file.size / 1024).toFixed(1)} KB
          </p>
        </div>
        {!disabled && (
          <button
            onClick={onClear}
            className="text-sm transition-colors duration-150 hover:text-error"
            style={{ color: 'var(--tx-secondary)' }}
          >
            Remove
          </button>
        )}
      </div>
    )
  }

  return (
    <div
      {...getRootProps()}
      className="flex flex-col items-center justify-center gap-3 px-6 py-14 rounded-[8px] cursor-pointer transition-colors duration-150"
      style={{
        border: `2px dashed ${isDragActive ? 'rgba(245,78,0,0.5)' : 'var(--border-warm)'}`,
        backgroundColor: isDragActive ? 'rgba(245,78,0,0.04)' : 'var(--bg-card)',
      }}
    >
      <input {...getInputProps()} />
      <Upload size={28} style={{ color: 'var(--tx-tertiary)' }} />
      <div className="text-center">
        <p className="text-sm font-medium" style={{ color: 'var(--tx-primary)' }}>
          {isDragActive ? 'Drop it here' : 'Drag & drop a file'}
        </p>
        <p className="text-xs mt-1" style={{ color: 'var(--tx-secondary)' }}>
          PDF or image (JPG, PNG, WEBP)
        </p>
      </div>
      <span
        className="px-3 py-1 text-xs rounded-full"
        style={{ backgroundColor: 'var(--bg-btn)', color: 'var(--tx-secondary)', border: '1px solid var(--border-warm)' }}
      >
        Browse files
      </span>
    </div>
  )
}
