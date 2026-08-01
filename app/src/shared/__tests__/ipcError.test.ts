import { describe, it, expect } from 'vitest'
import { cleanIpcErrorMessage } from '../ipcError'

// The wrapper text these cases assert is not invented: it was read out of the shipped
// electron 39.8.10 binary, where ipcRenderer.invoke is
//   async invoke(e,...t){const{error:r,result:o}=await i.invoke(a,e,t);
//     if(r)throw new Error(`Error invoking remote method '${e}': ${r}`);return o}
// so `${r}` is the main-process error already stringified — hence the doubled `Error:`.
describe('cleanIpcErrorMessage', () => {
  it('strips the wrapper and the redundant class prefix from a real invoke rejection', () => {
    expect(
      cleanIpcErrorMessage(
        "Error invoking remote method 'review:compose-run-prompt': Error: No pull request is bound to this case."
      )
    ).toBe('No pull request is bound to this case.')
  })

  it('strips a non-Error subclass prefix too', () => {
    expect(
      cleanIpcErrorMessage(
        "Error invoking remote method 'files:read': TypeError: path is not a string"
      )
    ).toBe('path is not a string')
  })

  it('leaves an ordinary author-written message untouched', () => {
    expect(cleanIpcErrorMessage('Could not load chat sessions.')).toBe(
      'Could not load chat sessions.'
    )
  })

  // err.message never contains the class name for a locally-thrown Error (new Error('x').message
  // === 'x'), so a leading `Error: ` outside the wrapper is the author's own text, not plumbing.
  it('does not strip a class-looking prefix when there was no wrapper', () => {
    expect(cleanIpcErrorMessage('Error: budget exceeded')).toBe('Error: budget exceeded')
  })

  it('handles a channel name and a message that both contain colons', () => {
    expect(
      cleanIpcErrorMessage("Error invoking remote method 'jira:sync-all': Error: sync failed: 401")
    ).toBe('sync failed: 401')
  })

  it('strips only one layer, so a message quoting the wrapper survives readably', () => {
    expect(
      cleanIpcErrorMessage('Error invoking remote method \'a:b\': Error: saw "Error: nested"')
    ).toBe('saw "Error: nested"')
  })

  it('falls back to the raw message when stripping would leave nothing', () => {
    const empty = "Error invoking remote method 'a:b': "
    expect(cleanIpcErrorMessage(empty)).toBe(empty)
  })

  it('tolerates an empty message', () => {
    expect(cleanIpcErrorMessage('')).toBe('')
  })
})
