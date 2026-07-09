import { useEffect, useState } from 'react'
import type { SkillMeta } from '../../../shared/types'

export function Composer({
  disabled,
  onSend
}: {
  disabled: boolean
  onSend: (text: string) => void
}): React.JSX.Element {
  const [text, setText] = useState('')
  const [skills, setSkills] = useState<SkillMeta[]>([])

  useEffect(() => {
    void window.argus.skills.list().then(setSkills)
  }, [])

  const showSkills = text.startsWith('/') && !text.includes(' ')
  const matches = skills.filter((s) => s.name.startsWith(text.slice(1)))

  function send(): void {
    const t = text.trim()
    if (!t) return
    onSend(t)
    setText('')
  }

  return (
    <div className="relative border-t border-hair bg-deep p-2.5">
      {showSkills && matches.length > 0 && (
        <div className="absolute bottom-full left-2.5 mb-1 w-96 rounded-r2 border border-hair bg-overlay p-1 shadow-lg">
          {matches.map((s) => (
            <button
              key={s.name}
              className="block w-full rounded-r1 px-2 py-1 text-left transition-colors hover:bg-hi"
              onClick={() => setText(`/${s.name} `)}
            >
              <span className="font-mono text-xs text-defect">/{s.name}</span>
              <span className="ml-2 text-xs text-mute">{s.description}</span>
            </button>
          ))}
        </div>
      )}
      <div className="flex flex-col gap-1 rounded-r3 border border-hair bg-panel p-2 transition-colors focus-within:border-hair2">
        <textarea
          rows={2}
          className="w-full resize-none bg-transparent px-1 pt-0.5 text-sm text-ink placeholder:text-mute focus:outline-none"
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
        <div className="flex items-center gap-2 px-1 font-mono text-[10px] text-mute">
          <span>⏎ send</span>
          <span>⇧⏎ newline</span>
          <span>/ skills</span>
        </div>
      </div>
    </div>
  )
}
