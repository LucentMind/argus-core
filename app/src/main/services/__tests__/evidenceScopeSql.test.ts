import { describe, it, expect } from 'vitest'
import { scopeClause } from '../evidenceScopeSql'

describe('scopeClause', () => {
  it('excludes the artifacts tree for investigation', () => {
    expect(scopeClause('investigation')).toEqual({
      sql: ' AND e.rel_path NOT LIKE ?',
      params: ['artifacts/%']
    })
  })

  it('restricts to the artifacts tree for review', () => {
    expect(scopeClause('review')).toEqual({
      sql: ' AND e.rel_path LIKE ?',
      params: ['artifacts/%']
    })
  })

  it('adds no fragment and binds nothing for all', () => {
    expect(scopeClause('all')).toEqual({ sql: '', params: [] })
  })
})
