/**
 * Prompt-injection detection.
 *
 * Documents are untrusted DATA. Nothing here executes, follows or forwards an
 * instruction found in a document: this module only raises a flag so the
 * calling plugin can warn the user that the material contains instruction-like
 * text. The match list is bounded and the matched text is never re-emitted as
 * instructions.
 *
 * @module dsh-doc-anchor/extract/injection
 */

/** One suspicious match (pattern id + short excerpt, never the whole doc). */
export interface InjectionFinding {
  /** Stable pattern id. */
  readonly id: string
  /** What the pattern looks for. */
  readonly description: string
}

const PATTERNS: ReadonlyArray<{ id: string; description: string; pattern: RegExp }> = [
  {
    id: 'ignore-previous',
    description: 'asks to ignore or forget earlier instructions',
    pattern: /ignore\s+(?:all\s+)?(?:the\s+)?(?:previous|prior|above|earlier)\s+instructions?/iu,
  },
  {
    id: 'disregard-system',
    description: 'asks to disregard the system prompt or rules',
    pattern: /disregard\s+(?:the\s+)?(?:system|developer|previous)\s+(?:prompt|instructions?|rules?)/iu,
  },
  {
    id: 'reveal-secret',
    description: 'asks to reveal or send credentials / hidden prompts',
    pattern: /(?:reveal|print|send|upload|post)\s+(?:me\s+)?(?:your\s+)?(?:system\s+prompt|api[_\s-]?key|token|secret|password)/iu,
  },
  {
    id: 'ignore-previous-zh',
    description: '要求忽略之前/以上的指令',
    pattern: /(?:忽略|无视|忘记).{0,8}(?:之前|以上|前面|先前).{0,6}(?:指令|提示|规则|要求)/u,
  },
  {
    id: 'send-secret-zh',
    description: '要求发送密钥/令牌',
    pattern: /(?:发送|上传|输出|泄露).{0,10}(?:密钥|令牌|api[_\s-]?key|密码|token)/iu,
  },
  {
    id: 'run-command',
    description: 'asks an agent to run shell commands found in the document',
    pattern: /(?:run|execute)\s+(?:the\s+following\s+)?(?:shell\s+)?(?:command|script|code)\s*[:：]/iu,
  },
]

/** Bound on findings so a pathological file cannot produce unbounded output. */
const MAX_FINDINGS = 8

/**
 * Scan extracted text for instruction-like content.
 * @param text - the extracted document text (untrusted data).
 * @returns the findings (bounded, metadata only).
 */
export function detectInjection(text: string): InjectionFinding[] {
  const findings: InjectionFinding[] = []
  for (const { id, description, pattern } of PATTERNS) {
    if (pattern.test(text)) {
      findings.push({ id, description })
      if (findings.length >= MAX_FINDINGS) break
    }
  }
  return findings
}

/**
 * Turn findings into human warnings.
 * @param findings - the detected patterns.
 * @returns one warning line per finding.
 */
export function injectionWarnings(findings: readonly InjectionFinding[]): string[] {
  return findings.map(
    finding =>
      `prompt_injection_suspected: the document ${finding.description} (${finding.id}); it was treated as data and never executed`,
  )
}
