import { describe, expect, it } from 'vitest';
import { errorResponse, formatMoney, generateId, isValidHandle, jsonResponse } from '../utils';

describe('generateId', () => {
  it('prefixes the id and produces unique values', () => {
    const a = generateId('tip');
    const b = generateId('tip');

    expect(a).toMatch(/^tip_[a-z0-9]+$/);
    expect(a).not.toBe(b);
  });
});

describe('isValidHandle', () => {
  it.each(['abc', 'creator_1', 'a'.repeat(30)])('accepts %s', (handle) => {
    expect(isValidHandle(handle)).toBe(true);
  });

  it.each(['ab', 'a'.repeat(31), 'Upper', 'has-dash', 'has space', ''])('rejects %j', (handle) => {
    expect(isValidHandle(handle)).toBe(false);
  });
});

describe('formatMoney', () => {
  it('formats USD cents as dollars', () => {
    expect(formatMoney(1250)).toBe('$12.50');
  });

  it('formats SOL lamports', () => {
    expect(formatMoney(1_500_000_000, 'SOL')).toBe('1.5000 SOL');
  });
});

describe('response helpers', () => {
  it('jsonResponse defaults to 200', async () => {
    const res = jsonResponse({ ok: true });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('jsonResponse honours an explicit status', () => {
    expect(jsonResponse({}, 201).status).toBe(201);
  });

  it('errorResponse defaults to 400 and wraps the message', async () => {
    const res = errorResponse('nope');

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'nope' });
  });

  it('errorResponse honours an explicit status', () => {
    expect(errorResponse('gone', 404).status).toBe(404);
  });
});
