import { expect, it } from 'vitest';
import { buildApiTree } from './apiTree';

it('groups operations into APIs and nested folders, sorted', () => {
  const tree = buildApiTree([
    { id: 'a', name: 'Create', path: 'claims/claims/create', http: { method: 'POST', path: '/claims' } },
    { id: 'b', name: 'Get', path: 'claims/claims/get', http: { method: 'GET', path: '/claims/:id' } },
    { id: 'c', name: 'Charge', path: 'billing/charge' },
  ]);
  expect(tree.map((a) => a.name)).toEqual(['billing', 'claims']); // sorted
  const claims = tree.find((a) => a.name === 'claims')!;
  expect(claims.folders[0].name).toBe('claims');
  expect(claims.folders[0].operations.map((o) => o.id)).toEqual(['a', 'b']); // Create, Get by name
  expect(claims.folders[0].operations[0].method).toBe('POST');
  const billing = tree.find((a) => a.name === 'billing')!;
  expect(billing.operations.map((o) => o.id)).toEqual(['c']); // no folder → directly under api
});
