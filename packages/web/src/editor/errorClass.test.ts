import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/client';
import { classifyFlushError } from './errorClass';

describe('classifyFlushError', () => {
  it('409 → conflict', () => {
    expect(classifyFlushError(new ApiError(409, 'REVISION_CONFLICT', 'x'))).toBe('conflict');
  });
  it('422 content_save_invalid → semantic', () => {
    expect(classifyFlushError(new ApiError(422, 'content_save_invalid', 'x'))).toBe('semantic');
  });
  it('other 4xx → semantic', () => {
    expect(classifyFlushError(new ApiError(400, 'INVALID_REQUEST', 'x'))).toBe('semantic');
    expect(classifyFlushError(new ApiError(404, 'NOT_FOUND', 'x'))).toBe('semantic');
  });
  it('5xx → transient', () => {
    expect(classifyFlushError(new ApiError(500, 'INTERNAL', 'x'))).toBe('transient');
    expect(classifyFlushError(new ApiError(503, 'UNAVAILABLE', 'x'))).toBe('transient');
  });
  it('a non-ApiError throw (network/offline) → transient', () => {
    expect(classifyFlushError(new TypeError('Failed to fetch'))).toBe('transient');
    expect(classifyFlushError('weird')).toBe('transient');
  });
});
