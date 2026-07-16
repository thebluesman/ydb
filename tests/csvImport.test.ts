import { describe, expect, it } from 'vitest'
import {
  parseCsv,
  parseCsvDate,
  applyCsvMapping,
  isMappingComplete,
  parseOfx,
  looksLikeOfx,
  type CsvMapping,
} from '@/lib/csvImport'

describe('parseCsv', () => {
  it('splits plain rows on commas', () => {
    expect(parseCsv('a,b,c\n1,2,3')).toEqual([['a', 'b', 'c'], ['1', '2', '3']])
  })

  it('handles quoted fields with embedded commas and newlines', () => {
    const text = 'date,description,amount\n2024-01-01,"Coffee, Inc.",-5.50\n2024-01-02,"Multi\nline",-1.00'
    expect(parseCsv(text)).toEqual([
      ['date', 'description', 'amount'],
      ['2024-01-01', 'Coffee, Inc.', '-5.50'],
      ['2024-01-02', 'Multi\nline', '-1.00'],
    ])
  })

  it('unescapes doubled quotes', () => {
    expect(parseCsv('"Say ""hi"""')).toEqual([['Say "hi"']])
  })

  it('drops trailing blank rows', () => {
    expect(parseCsv('a,b\n1,2\n\n')).toEqual([['a', 'b'], ['1', '2']])
  })

  it('handles a file with no trailing newline', () => {
    expect(parseCsv('a,b\n1,2')).toEqual([['a', 'b'], ['1', '2']])
  })
})

describe('parseCsvDate', () => {
  it('parses YYYY-MM-DD', () => {
    expect(parseCsvDate('2024-03-05', 'YYYY-MM-DD')).toBe('2024-03-05')
  })
  it('parses MM/DD/YYYY', () => {
    expect(parseCsvDate('03/05/2024', 'MM/DD/YYYY')).toBe('2024-03-05')
  })
  it('parses DD/MM/YYYY', () => {
    expect(parseCsvDate('05/03/2024', 'DD/MM/YYYY')).toBe('2024-03-05')
  })
  it('parses MM-DD-YYYY and DD-MM-YYYY', () => {
    expect(parseCsvDate('03-05-2024', 'MM-DD-YYYY')).toBe('2024-03-05')
    expect(parseCsvDate('05-03-2024', 'DD-MM-YYYY')).toBe('2024-03-05')
  })
  it('rejects an out-of-range month/day', () => {
    expect(parseCsvDate('13/40/2024', 'MM/DD/YYYY')).toBeNull()
  })
  it('rejects garbage', () => {
    expect(parseCsvDate('not a date', 'YYYY-MM-DD')).toBeNull()
    expect(parseCsvDate('', 'YYYY-MM-DD')).toBeNull()
  })
})

describe('isMappingComplete', () => {
  it('requires date, description, and dateFormat', () => {
    expect(isMappingComplete({ dateCol: 0, descriptionCol: 1, amountCol: 2 })).toBe(false)
  })
  it('accepts a single amount column', () => {
    expect(isMappingComplete({ dateCol: 0, descriptionCol: 1, dateFormat: 'YYYY-MM-DD', amountCol: 2, debitCol: null, creditCol: null, hasHeaderRow: true })).toBe(true)
  })
  it('accepts debit+credit columns without a single amount column', () => {
    expect(isMappingComplete({ dateCol: 0, descriptionCol: 1, dateFormat: 'YYYY-MM-DD', amountCol: null, debitCol: 2, creditCol: 3, hasHeaderRow: true })).toBe(true)
  })
  it('rejects debit-only without credit', () => {
    expect(isMappingComplete({ dateCol: 0, descriptionCol: 1, dateFormat: 'YYYY-MM-DD', amountCol: null, debitCol: 2, creditCol: null, hasHeaderRow: true })).toBe(false)
  })
})

describe('applyCsvMapping', () => {
  it('maps a single signed-amount column, inferring debit/credit from sign', () => {
    const rows = parseCsv('Date,Desc,Amount\n2024-01-05,Groceries,-42.50\n2024-01-06,Paycheck,1000.00')
    const mapping: CsvMapping = {
      dateCol: 0, descriptionCol: 1, amountCol: 2, debitCol: null, creditCol: null,
      dateFormat: 'YYYY-MM-DD', hasHeaderRow: true,
    }
    const { transactions, skipped } = applyCsvMapping(rows, mapping)
    expect(skipped).toBe(0)
    expect(transactions).toEqual([
      { date: '2024-01-05', description: 'Groceries', amount: -42.5, transactionType: 'debit' },
      { date: '2024-01-06', description: 'Paycheck', amount: 1000, transactionType: 'credit' },
    ])
  })

  it('maps separate debit/credit columns and always signs debit negative', () => {
    const rows = parseCsv('Date,Desc,Debit,Credit\n2024-02-01,Rent,900.00,\n2024-02-02,Refund,,50.00')
    const mapping: CsvMapping = {
      dateCol: 0, descriptionCol: 1, amountCol: null, debitCol: 2, creditCol: 3,
      dateFormat: 'YYYY-MM-DD', hasHeaderRow: true,
    }
    const { transactions, skipped } = applyCsvMapping(rows, mapping)
    expect(skipped).toBe(0)
    expect(transactions).toEqual([
      { date: '2024-02-01', description: 'Rent', amount: -900, transactionType: 'debit' },
      { date: '2024-02-02', description: 'Refund', amount: 50, transactionType: 'credit' },
    ])
  })

  it('skips rows with an unparseable date and counts them', () => {
    const rows = parseCsv('Date,Desc,Amount\nnot-a-date,X,-1.00\n2024-01-01,Y,-2.00')
    const mapping: CsvMapping = {
      dateCol: 0, descriptionCol: 1, amountCol: 2, debitCol: null, creditCol: null,
      dateFormat: 'YYYY-MM-DD', hasHeaderRow: true,
    }
    const { transactions, skipped } = applyCsvMapping(rows, mapping)
    expect(skipped).toBe(1)
    expect(transactions).toHaveLength(1)
  })

  it('handles accounting-style negative amounts in parens', () => {
    const rows = parseCsv('Date,Desc,Amount\n2024-01-01,Fee,(12.34)')
    const mapping: CsvMapping = {
      dateCol: 0, descriptionCol: 1, amountCol: 2, debitCol: null, creditCol: null,
      dateFormat: 'YYYY-MM-DD', hasHeaderRow: true,
    }
    const { transactions } = applyCsvMapping(rows, mapping)
    expect(transactions[0].amount).toBe(-12.34)
    expect(transactions[0].transactionType).toBe('debit')
  })

  it('respects hasHeaderRow: false', () => {
    const rows = parseCsv('2024-01-01,Groceries,-10.00')
    const mapping: CsvMapping = {
      dateCol: 0, descriptionCol: 1, amountCol: 2, debitCol: null, creditCol: null,
      dateFormat: 'YYYY-MM-DD', hasHeaderRow: false,
    }
    const { transactions } = applyCsvMapping(rows, mapping)
    expect(transactions).toHaveLength(1)
    expect(transactions[0].description).toBe('Groceries')
  })
})

describe('OFX parsing', () => {
  const OFX_SAMPLE = `
OFXHEADER:100
DATA:OFXSGML
<OFX>
<BANKMSGSRSV1>
<STMTTRNRS>
<STMTRS>
<BANKTRANLIST>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20240115120000
<TRNAMT>-42.50
<NAME>Coffee Shop
</STMTTRN>
<STMTTRN>
<TRNTYPE>CREDIT
<DTPOSTED>20240116
<TRNAMT>1000.00
<NAME>Paycheck
</STMTTRN>
</BANKTRANLIST>
</STMTRS>
</STMTTRNRS>
</BANKMSGSRSV1>
</OFX>
`

  it('detects OFX by extension or content', () => {
    expect(looksLikeOfx('statement.ofx', '')).toBe(true)
    expect(looksLikeOfx('statement.qfx', '')).toBe(true)
    expect(looksLikeOfx('statement.csv', OFX_SAMPLE)).toBe(true)
    expect(looksLikeOfx('statement.csv', 'date,amount\n1,2')).toBe(false)
  })

  it('extracts transactions from STMTTRN blocks', () => {
    const txs = parseOfx(OFX_SAMPLE)
    expect(txs).toEqual([
      { date: '2024-01-15', description: 'Coffee Shop', amount: -42.5, transactionType: 'debit' },
      { date: '2024-01-16', description: 'Paycheck', amount: 1000, transactionType: 'credit' },
    ])
  })

  it('returns an empty array for text with no STMTTRN blocks', () => {
    expect(parseOfx('not ofx at all')).toEqual([])
  })
})
