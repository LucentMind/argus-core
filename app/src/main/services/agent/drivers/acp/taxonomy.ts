import type { ToolTaxonomy } from '../../risk'

export const ACP_TOOL_TAXONOMY: ToolTaxonomy = {
  entries: {
    write: { kind: 'fs-write', pathFields: ['file_path'] },
    read: { kind: 'fs-read', pathFields: ['file_path'] },
    shell: { kind: 'shell', commandField: 'command' },
    fetch: { kind: 'network', urlField: 'url' }
  }
}
