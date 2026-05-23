/**
 * Client-side syntax checking for Shell and Python scripts.
 * 
 * Shell: regex-based pattern detection (common mistakes)
 * Python: uses Monaco's built-in python language support + extra rules
 */

export interface SyntaxError {
  line: number
  col: number
  message: string
  severity: 'error' | 'warning'
}

// ── Shell syntax checker ───────────────────────────────────────────────────
const SHELL_RULES: Array<{
  pattern: RegExp
  message: string
  severity: 'error' | 'warning'
}> = [
  // Missing space in [ ] conditions
  { pattern: /\[(?!\s)|\[.*(?<!\s)\]/, message: '[ 和 ] 内侧需要空格，如 [ -n "$var" ]', severity: 'error' },
  // Unquoted variable in test
  { pattern: /\[\s*\$\w+\s*[=!]/, message: '建议引用变量：[ "$var" = "..." ]', severity: 'warning' },
  // Missing fi
  // Backtick usage (prefer $())
  { pattern: /`[^`]+`/, message: '建议用 $(...) 替代反引号，可读性更好', severity: 'warning' },
  // cd without error handling
  { pattern: /^\s*cd\s+[^;|&\n]+(?!\s*\|\|\s*(?:exit|return|die))/, message: 'cd 失败时不会自动退出，建议：cd /path || exit 1', severity: 'warning' },
  // Unquoted $@ or $*
  { pattern: /(?<!")(\$@|\$\*)(?!")/, message: '"$@" 应加引号避免分词问题', severity: 'warning' },
  // Double-bracket spacing
  { pattern: /\[\[(?!\s)|\[\[.*(?<!\s)\]\]/, message: '[[ ]] 内侧需要空格', severity: 'error' },
  // echo -e without shebang awareness
  { pattern: /echo\s+-[eEn]\s/, message: 'echo -e 在部分 shell 中行为不一致，考虑用 printf', severity: 'warning' },
  // Set -e / pipefail suggestion
  { pattern: /^#!/, message: '', severity: 'warning' }, // placeholder, handled below
]

export function checkShellSyntax(code: string): SyntaxError[] {
  const errors: SyntaxError[] = []
  const lines = code.split('\n')

  // Check for set -e / set -o pipefail recommendation
  const hasSetE = code.includes('set -e') || code.includes('set -o errexit')
  const hasPipefail = code.includes('set -o pipefail') || code.includes('set -eo pipefail')
  if (!hasSetE && code.length > 50) {
    errors.push({ line: 1, col: 1, severity: 'warning', message: '建议在脚本开头添加 set -e（遇错退出）' })
  }
  if (!hasPipefail && code.length > 50) {
    errors.push({ line: 1, col: 1, severity: 'warning', message: '建议添加 set -o pipefail（管道错误检测）' })
  }

  lines.forEach((line, idx) => {
    const lineNo = idx + 1
    const trimmed = line.trimStart()

    // Skip comments
    if (trimmed.startsWith('#')) return

    // Unmatched quotes (simple check)
    const singleQuotes = (line.match(/(?<!\\)'/g) || []).length
    const doubleQuotes = (line.match(/(?<!\\)"/g) || []).length
    if (singleQuotes % 2 !== 0) {
      errors.push({ line: lineNo, col: 1, severity: 'error', message: '单引号未闭合' })
    }
    if (doubleQuotes % 2 !== 0) {
      errors.push({ line: lineNo, col: 1, severity: 'error', message: '双引号未闭合' })
    }

    // Check each rule
    for (const rule of SHELL_RULES) {
      if (!rule.message) continue
      if (rule.pattern.test(line)) {
        const match = line.match(rule.pattern)
        const col = match ? line.indexOf(match[0]) + 1 : 1
        // Avoid duplicate errors
        const isDup = errors.some(e => e.line === lineNo && e.message === rule.message)
        if (!isDup) {
          errors.push({ line: lineNo, col, severity: rule.severity, message: rule.message })
        }
      }
    }

    // Missing space around = in assignments inside if
    if (/if\s+\[.*=.*\]/.test(line) && !/if\s+\[.*\s=\s.*\]/.test(line)) {
      errors.push({ line: lineNo, col: 1, severity: 'error', message: '= 两侧需要空格（用于字符串比较）' })
    }
  })

  return errors
}

// ── Python syntax checker ─────────────────────────────────────────────────
const PYTHON_RULES: Array<{
  pattern: RegExp
  message: string
  severity: 'error' | 'warning'
}> = [
  // print without parentheses (Python 2 style)
  { pattern: /^\s*print\s+(?!\()/, message: 'Python 3 中 print 是函数：print()', severity: 'error' },
  // except without specifying exception type
  { pattern: /^\s*except\s*:/, message: '建议指定异常类型：except Exception as e', severity: 'warning' },
  // Mutable default argument
  { pattern: /def\s+\w+\s*\([^)]*=\s*[\[\{]/, message: '不建议使用可变对象作为默认参数', severity: 'warning' },
  // == None/True/False (use is)
  { pattern: /==\s*(?:None|True|False)/, message: '建议用 is/is not 而非 == 比较 None/True/False', severity: 'warning' },
  // Star import
  { pattern: /from\s+\w+\s+import\s+\*/, message: '不建议 import *，会污染命名空间', severity: 'warning' },
  // Unused variable (_)
  { pattern: /^\s*(\w+)\s*=\s*.*\n(?!.*\1)/, message: '', severity: 'warning' }, // too complex, skip
  // f-string without f prefix
  { pattern: /"\{[^}]+\}"/, message: '包含 {} 的字符串可能需要 f-string（在引号前加 f）', severity: 'warning' },
  // Bare except
  { pattern: /^\s*except\s*:/, message: '裸 except 会捕获所有异常包括 KeyboardInterrupt', severity: 'warning' },
]

export function checkPythonSyntax(code: string): SyntaxError[] {
  const errors: SyntaxError[] = []
  const lines = code.split('\n')

  // Check indentation consistency
  let usesSpaces = false
  let usesTabs = false
  lines.forEach((line, idx) => {
    if (line.startsWith('    ')) usesSpaces = true
    if (line.startsWith('\t')) usesTabs = true
    if (usesSpaces && usesTabs) {
      errors.push({
        line: idx + 1, col: 1, severity: 'error',
        message: '缩进混用了空格和 Tab，Python 不允许混用',
      })
      usesSpaces = false; usesTabs = false // only report once
    }
  })

  lines.forEach((line, idx) => {
    const lineNo = idx + 1
    const trimmed = line.trimStart()

    // Skip comments and strings
    if (trimmed.startsWith('#')) return

    for (const rule of PYTHON_RULES) {
      if (!rule.message) continue
      if (rule.pattern.test(line)) {
        const match = line.match(rule.pattern)
        const col = match ? line.indexOf(match[0]) + 1 : 1
        const isDup = errors.some(e => e.line === lineNo && e.message === rule.message)
        if (!isDup) {
          errors.push({ line: lineNo, col, severity: rule.severity, message: rule.message })
        }
      }
    }

    // Check unmatched parentheses in the line
    const opens  = (line.match(/\(/g) || []).length
    const closes = (line.match(/\)/g) || []).length
    // Note: multi-line expressions are valid, only flag obvious mismatches
    // This is too complex for line-by-line, skip

    // Colon missing at end of def/class/if/for/while/with/try/except/else/elif/finally
    if (/^\s*(def|class|if|elif|else|for|while|with|try|except|finally)\b/.test(line) &&
        !line.trimEnd().endsWith(':') &&
        !line.trimEnd().endsWith('\\') &&
        !line.includes('#')) {
      errors.push({
        line: lineNo, col: line.length,
        severity: 'error',
        message: '语句末尾缺少冒号 :',
      })
    }
  })

  return errors
}

export function checkSyntax(code: string, lang: 'sh' | 'py'): SyntaxError[] {
  if (!code || !code.trim()) return []
  return lang === 'sh' ? checkShellSyntax(code) : checkPythonSyntax(code)
}
