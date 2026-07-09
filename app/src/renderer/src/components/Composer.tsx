import { useEffect, useState } from 'react'
import type { SkillMeta } from '../../../shared/types'

export function Composer({
  disabled,
  onSend,
  prefill
}: {
  disabled: boolean
  onSend: (text: string) => void
  prefill?: string
}): React.JSX.Element {
  const [text, setText] = useState('')
  const [skills, setSkills] = useState<SkillMeta[]>([])

  useEffect(() => {
    void window.argus.skills.list().then(setSkills)
  }, [])

  // suggestion buttons (e.g. Analyze in the evidence library) overwrite the draft
  useEffect(() => {
    if (prefill) setText(prefill)
  }, [prefill])

  const showSkills = text.startsWith('/') && !text.includes(' ')
  const matches = skills.filter((s) => s.name.startsWith(text.slice(1)))

  function send(): void {
    const t = text.trim()
    if (!t) return
    onSend(t)
    setText('')
  }

  return (
    <div className="relative border-t border-hair bg-panel p-2">
      {showSkills && matches.length > 0 && (
        <div className="absolute bottom-full left-2 mb-1 w-96 rounded-r2 border border-hair bg-overlay p-1">
          {matches.map((s) => (
            <button
              key={s.name}
              className="block w-full rounded-r1 px-2 py-1 text-left hover:bg-panel"
              onClick={() => setText(`/${s.name} `)}
            >
              <span className="font-mono text-xs text-defect">/{s.name}</span>
              <span className="ml-2 text-xs text-mute">{s.description}</span>
            </button>
          ))}
        </div>
      )}
      <textarea
        rows={2}
        className="w-full resize-none rounded-r2 border border-hair bg-overlay p-2 text-sm text-ink placeholder:text-mute focus:outline-none"
        placeholder="Message the analyst — / for skills"
        value={text}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            send()
          }
        }}
      />
    </div>
  )
}
