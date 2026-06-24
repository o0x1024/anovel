function sanitizeJsonString(str) {
  let inString = false
  let escaped = false
  let result = ''
  for (let i = 0; i < str.length; i++) {
    const char = str[i]
    if (inString) {
      if (escaped) {
        result += char
        escaped = false
      } else if (char === '\\') {
        result += char
        escaped = true
      } else if (char === '"') {
        result += char
        inString = false
      } else if (char === '\n') {
        result += '\\n'
      } else if (char === '\r') {
        result += '\\r'
      } else if (char === '\t') {
        result += '\\t'
      } else {
        result += char
      }
    } else {
      if (char === '"') {
        inString = true
      }
      result += char
    }
  }
  return result
}

function parseDiagnosisResult(raw) {
  let text = raw.trim()
  
  // 1. Extract markdown code block if present
  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (match) {
    text = match[1].trim()
  } else {
    // 2. Otherwise extract between first { and last }
    const firstBrace = text.indexOf('{')
    const lastBrace = text.lastIndexOf('}')
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      text = text.substring(firstBrace, lastBrace + 1)
    }
  }

  // 3. Sanitize literal newlines and tabs inside quotes
  text = sanitizeJsonString(text)

  try {
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed === 'object' && 'report' in parsed) {
      return {
        report: String(parsed.report || ''),
        revised_chapters: Array.isArray(parsed.revised_chapters) ? parsed.revised_chapters : null
      }
    }
  } catch (e) {
    console.error('Failed to parse JSON:', e.message)
  }
  return {
    report: raw,
    revised_chapters: null
  }
}

// Test with literal newline inside double quotes
const badJson = `{
  "report": "Line 1
Line 2 with tab \t and newline
Line 3",
  "revised_chapters": [
    { "chapter_id": 1, "outline": "test" }
  ]
}`

console.log('Original parsing will fail:')
try {
  JSON.parse(badJson)
} catch(e) {
  console.log('Error caught:', e.message)
}

console.log('\nSanitized parsing success:')
const res = parseDiagnosisResult(badJson)
console.log(res)
