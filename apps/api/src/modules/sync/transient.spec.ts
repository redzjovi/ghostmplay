import { describe, it, expect } from 'vitest'
import { isTransientError, describeError } from './transient'

describe('isTransientError', () => {
  it('treats DNS failures as transient', () => {
    // Observed in production: a container DNS blip aborted a whole cron job.
    expect(isTransientError(Object.assign(new Error('getaddrinfo EAI_AGAIN market-api.numine.io'), { code: 'EAI_AGAIN' }))).toBe(true)
    expect(isTransientError({ code: 'ENOTFOUND' })).toBe(true)
    expect(isTransientError({ code: 'EAI_NONAME' })).toBe(true)
  })

  it('treats connection-level failures as transient', () => {
    for (const code of ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH']) {
      expect(isTransientError({ code })).toBe(true)
    }
  })

  it('reads the code off a nested cause', () => {
    expect(isTransientError({ cause: { code: 'ECONNRESET' } })).toBe(true)
  })

  it('retries rate limits and server faults', () => {
    expect(isTransientError({ response: { status: 429 } })).toBe(true)
    expect(isTransientError({ response: { status: 500 } })).toBe(true)
    expect(isTransientError({ response: { status: 503 } })).toBe(true)
    expect(isTransientError({ response: { status: 408 } })).toBe(true)
  })

  it('does not retry a response that will never succeed', () => {
    // A 400 means the request itself is wrong; retrying only burns rate limit.
    expect(isTransientError({ response: { status: 400 } })).toBe(false)
    expect(isTransientError({ response: { status: 404 } })).toBe(false)
    expect(isTransientError({ response: { status: 401 } })).toBe(false)
  })

  it('does not retry ordinary programming errors', () => {
    expect(isTransientError(new TypeError('x is not a function'))).toBe(false)
    expect(isTransientError(new Error('Favorite not found'))).toBe(false)
    expect(isTransientError(null)).toBe(false)
    expect(isTransientError('nope')).toBe(false)
  })

  it('recognises transient messages without a code', () => {
    expect(isTransientError(new Error('socket hang up'))).toBe(true)
    expect(isTransientError(new Error('timeout of 15000ms exceeded'))).toBe(true)
  })
})

describe('describeError', () => {
  it('includes the code, status and message', () => {
    const text = describeError(Object.assign(new Error('boom'), { code: 'ECONNRESET' }))
    expect(text).toContain('ECONNRESET')
    expect(text).toContain('boom')
  })

  it('includes an HTTP status when there is one', () => {
    expect(describeError({ response: { status: 503 }, message: 'unavailable' })).toContain('HTTP 503')
  })

  it('handles non-error values', () => {
    expect(describeError('plain string')).toBe('plain string')
  })
})
