import { buildAccessPolicy, LOOPBACK_HOSTS, parseAllowedHosts, parseAllowedOrigins } from '../src/access/access-policy';

describe('access policy lists', () => {
  it('splits on commas, trims, drops empties', () => {
    expect(parseAllowedOrigins(' http://localhost:5173 ,, ')).toEqual(['http://localhost:5173']);
    expect(parseAllowedHosts('Demo.Example, b.example')).toEqual(['demo.example', 'b.example']);
  });

  it('builds sets', () => {
    const p = buildAccessPolicy('http://localhost:5173', 'demo.example');
    expect([...p.allowedOrigins]).toEqual(['http://localhost:5173']);
    expect([...p.allowedHosts]).toEqual(['demo.example']);
  });

  it('loopback set is exactly the three names', () => {
    expect([...LOOPBACK_HOSTS].sort()).toEqual(['127.0.0.1', '[::1]', 'localhost']);
  });
});
