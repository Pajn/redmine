import {compare} from '.'

describe('compare', () => {
  it('should match', () => {
    expect(compare('abc', {name: 'abc'})).toBe(true)
    expect(compare('abc', {name: 'abcdef'})).toBe(true)
    expect(compare('cde', {name: 'abcdef'})).toBe(true)
    expect(compare('123', {id: 123})).toBe(true)
  })

  it('should not match', () => {
    expect(compare('123', {id: 123456})).toBe(false)
    expect(compare('234', {id: 1234})).toBe(false)
  })

  it('should match', () => {
    expect(compare('none', undefined)).toBe(true)
    expect(compare('!none', {id: 123456})).toBe(true)
  })

  it('should not match', () => {
    expect(compare('none', {id: 123456})).toBe(false)
    expect(compare('!none', undefined)).toBe(false)
  })
})
