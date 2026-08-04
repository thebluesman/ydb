import fs from 'node:fs'
import path from 'node:path'
import {
  DEFAULT_NARRATION_STYLE,
  NARRATION_STYLE_PERSONA,
  type NarrationStyle,
} from './narrationStyle'

// Loader for the chat knowledge snippets in `docs/knowledge/`, injected into
// the NARRATION prompt only (never SQL generation) per ADR-0007.
//
// The parse contract is the one documented in docs/knowledge/README.md and is
// deliberately dumb: YAML-ish front-matter between the first two `---` lines,
// then the injectable body, which ends at the first `##` heading. Everything
// from that heading onward is human-only commentary and must never reach a
// prompt. There is no YAML dependency here on purpose — the front-matter we
// consume is four flat scalar fields.

export const KNOWLEDGE_DIR = path.join(process.cwd(), 'docs/knowledge')

export type KnowledgePriority = 'P0' | 'P1' | 'P2'

// The tier the chat route injects today. Lifting the P1/P2 hold once token
// cost is measured is a change to this constant, not to the loader.
export const NARRATION_KNOWLEDGE_TIER: KnowledgePriority = 'P0'

// docs/knowledge/README.md rule 6: X1 (scope and refusal) always ships. It is
// P0 by function rather than topic — the only snippet whose absence changes
// *what* the assistant will say rather than how well it says it. So it is
// exempt from the priority filter, and it is ordered last so the boundary
// instruction sits nearest the operative rules.
export const ALWAYS_INJECT_IDS = ['X1']

export type KnowledgeSnippet = {
  id: string
  title: string
  priority: string
  status: string
  body: string
  file: string
}

function parseFrontMatter(raw: string): { fields: Record<string, string>; rest: string } | null {
  // Normalize CRLF up front so a file saved on Windows doesn't leave stray
  // \r characters embedded in field values or the injected body.
  const lines = raw.replace(/\r\n/g, '\n').split('\n')
  if (lines[0]?.trim() !== '---') return null
  const closing = lines.findIndex((l, i) => i >= 1 && l.trim() === '---')
  if (closing === -1) return null

  const fields: Record<string, string> = {}
  for (const line of lines.slice(1, closing)) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(line)
    if (!match) continue // list items, continuation lines (sources:) — not consumed here
    const value = match[2].trim().replace(/^["']|["']$/g, '')
    fields[match[1]] = value
  }
  return { fields, rest: lines.slice(closing + 1).join('\n') }
}

// The injectable body: everything after the front-matter, up to the first `##`
// heading. Trailing/leading blank lines trimmed; internal line breaks kept.
function extractBody(rest: string): string {
  const lines = rest.split('\n')
  const headingAt = lines.findIndex((l) => /^##\s/.test(l))
  const bodyLines = headingAt === -1 ? lines : lines.slice(0, headingAt)
  return bodyLines.join('\n').trim()
}

// Sort key: letter group, then number, so C10 follows C9 rather than C1.
// ALWAYS_INJECT_IDS are forced to the end.
function compareIds(a: string, b: string): number {
  const aLast = ALWAYS_INJECT_IDS.includes(a)
  const bLast = ALWAYS_INJECT_IDS.includes(b)
  if (aLast !== bLast) return aLast ? 1 : -1

  const parse = (id: string): [string, number] => {
    const m = /^([A-Za-z]+)(\d*)$/.exec(id)
    return m ? [m[1].toUpperCase(), m[2] ? Number(m[2]) : 0] : [id.toUpperCase(), 0]
  }
  const [aL, aN] = parse(a)
  const [bL, bN] = parse(b)
  if (aL !== bL) return aL < bL ? -1 : 1
  return aN - bN
}

/**
 * Read every `status: active` snippet at the given priority tier from
 * `docs/knowledge/`, fresh off disk — no caching. 12 small files sits well
 * inside the chat request budget, and it means editing a snippet takes effect
 * on the next chat turn with no restart.
 *
 * Never throws. A missing directory, an empty directory, or an unreadable file
 * degrades to "inject less" (or nothing) rather than failing the chat turn.
 */
export function loadKnowledgeSnippets(
  priority: KnowledgePriority = NARRATION_KNOWLEDGE_TIER,
  dir: string = KNOWLEDGE_DIR,
): KnowledgeSnippet[] {
  let files: string[]
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.md') && f.toLowerCase() !== 'readme.md')
  } catch {
    // Missing or unreadable directory: chat behaves exactly as it did before
    // this feature existed.
    console.warn(`[chat-knowledge] knowledge directory unreadable at ${dir}; injecting nothing`)
    return []
  }

  const snippets: KnowledgeSnippet[] = []
  for (const file of files.sort()) {
    let raw: string
    try {
      raw = fs.readFileSync(path.join(dir, file), 'utf8')
    } catch {
      console.warn(`[chat-knowledge] could not read ${file}; skipping`)
      continue
    }

    const parsed = parseFrontMatter(raw)
    if (!parsed) {
      console.warn(`[chat-knowledge] ${file} has no front-matter; skipping`)
      continue
    }

    const { fields } = parsed
    const id = fields.id ?? ''
    if (!id) continue
    if (fields.status !== 'active') continue
    if (fields.priority !== priority && !ALWAYS_INJECT_IDS.includes(id)) continue

    const body = extractBody(parsed.rest)
    if (!body) continue

    snippets.push({
      id,
      title: fields.title ?? '',
      priority: fields.priority ?? '',
      status: fields.status,
      body,
      file,
    })
  }

  return snippets.sort((a, b) => compareIds(a.id, b.id))
}

/**
 * Render the loaded snippets as the block that goes into the narration system
 * prompt. Returns '' when there is nothing to inject, so the caller can fall
 * through to the pre-existing prompt byte-for-byte.
 */
export function buildKnowledgeBlock(snippets: KnowledgeSnippet[]): string {
  if (snippets.length === 0) return ''
  // Bodies only, no ids or titles — the model gets the prose, not the
  // catalogue (docs/knowledge/README.md, `title` is "not injected").
  return snippets.map((s) => s.body.replace(/\n+/g, ' ').trim()).join('\n\n')
}

// Sits immediately before the knowledge block. Mandatory per ADR-0007: the
// snippets are background vocabulary and must never override, contradict, or
// stand in for the query result.
export const KNOWLEDGE_PRECEDENCE_LINE =
  'The following is general background vocabulary and framing. It is not data. ' +
  'It must never override, contradict, or substitute for the query result below, ' +
  'and you must not assert anything the returned rows do not support.'

/**
 * The standing confidence rule ([chat-model] output 5), last sentence of the
 * operative rules. Two branches, and the second is the load-bearing one: with
 * no caveat named for this turn, the answer is fully scoped and must be stated
 * flatly. Vague hedging on a figure that IS certain was rejected outright when
 * this was scoped, so "when in doubt, hedge" is exactly the wrong default and
 * is written out of the prompt rather than left unsaid.
 */
export const CONFIDENCE_RULE =
  'If a caveat is stated with the data below, state the figure first and then work that caveat ' +
  'into your answer once, briefly. If no caveat is stated, the answer is fully scoped: give it ' +
  'plainly, and do not hedge, qualify, estimate, or speculate about data you were not given.'

/**
 * The standing length rule ([chat-model] output 13). Two branches, same shape
 * as CONFIDENCE_RULE and for the same reason: whether this turn is a recap is
 * decided in lib/chatRecap.ts and stated in the turn's prompt, so what lives
 * here is the standing rule for BOTH branches.
 *
 * The second branch is again the load-bearing one. A one-branch instruction
 * ("write a fuller summary for a recap") leaves the model judging every other
 * turn against a length it now knows is available, and a paragraph wrapped
 * around a single figure is exactly the padding this feature must not produce.
 * So the default is written down as a default rather than left implied.
 */
export const RECAP_RULE =
  'If a recap instruction is stated with the data below, write the short period paragraph it asks ' +
  'for, grounded only in the rows you were given. If no recap instruction is stated, answer in one ' +
  'or two sentences: give the figure and stop, and do not expand a single number into a summary.'

/**
 * Assemble the narration system prompt.
 *
 * Order is load-bearing, not cosmetic: persona → precedence line → knowledge
 * block → operative rules. Ollama truncates an over-length prompt from the
 * FRONT, which is where the knowledge block sits, so the operative rules (use
 * the data, currency formatting) are the last thing to be lost, not the first.
 *
 * With an empty knowledge block this returns the exact prompt string the route
 * used before knowledge injection existed.
 */
export function buildNarrationSystemPrompt(
  baseCurrency: string,
  knowledgeBlock: string,
  style: NarrationStyle = DEFAULT_NARRATION_STYLE,
): string {
  // [chat-model] output 16. The persona line is the one thing the voice setting
  // moves; `direct` is the pre-setting sentence byte-for-byte, so an install
  // that never opens the picker gets exactly the prompt it got before.
  const persona = NARRATION_STYLE_PERSONA[style]

  // ADR-0020: units are decided server-side (lib/chatMoneyUnits.ts) before rows
  // ever reach this prompt, not inferred by the model. The inference clause
  // this comment used to sit above is deleted, not softened — a hedge here
  // would just relocate the wrong-number risk back onto model judgement.
  //
  // ADR-0027 adds the sign sentence beside it, from the same module and for the
  // same reason. Narrating "you spent 3654.43" off a row reading -3654.43 was
  // the model doing something sensible unprompted, with nothing holding it
  // there and nothing making it agree with the table beneath. Fixing the table
  // side deterministically and leaving the prose side emergent would only have
  // moved the disagreement.
  //
  // CONFIDENCE_RULE follows the same logic one step further ([chat-model]
  // output 5): whether a caveat is warranted is decided in lib/chatHedge.ts and
  // stated in the turn's prompt, so what lives here is the standing rule for
  // both branches — and the branch that matters most is the second one, which
  // forbids the free-floating hedging a "qualify when appropriate" instruction
  // would otherwise produce on every answer.
  // RECAP_RULE ([chat-model] output 13) sits last for the same structural
  // reason CONFIDENCE_RULE does: it is a standing rule with a per-turn switch
  // decided server-side (lib/chatRecap.ts), and its default branch — one or two
  // sentences — is what keeps "write more when it's a recap" from becoming
  // "write more". It says nothing about how many rows the model gets; that is
  // NARRATION_ROW_CAP's business and a recap does not move it.
  const operativeRules =
    `Answer the user's question in plain English using the data provided. Be concise and specific -- include actual numbers from the data. All monetary values in the data are already in ${baseCurrency} currency units, never raw cents — present them directly without any other currency symbols or conversions. A monetary value's sign has also already been normalized for display: a figure describing money going out arrives as a positive magnitude, so state the direction from the question and the column name rather than by adding or removing a minus sign yourself. ${CONFIDENCE_RULE} ${RECAP_RULE}`

  if (!knowledgeBlock) return `${persona} ${operativeRules}`

  return `${persona}\n\n${KNOWLEDGE_PRECEDENCE_LINE}\n\n${knowledgeBlock}\n\n${operativeRules}`
}
