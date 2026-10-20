import { integrationsEnabled } from '../src/integrations/integrations-enabled';

const L = '/Applications/Damwha.app/Contents/Resources/cli/damwha';

describe('integrationsEnabled', () => {
  it('enabled on loopback with launcher', () => {
    expect(integrationsEnabled({ HOST: '127.0.0.1', DEMO_READ_ONLY: 'false', DAMWHA_CLI_LAUNCHER: L })).toBe(true);
  });
  it('disabled without launcher', () => {
    expect(integrationsEnabled({ HOST: '127.0.0.1', DEMO_READ_ONLY: 'false' })).toBe(false);
    expect(integrationsEnabled({ HOST: '127.0.0.1', DEMO_READ_ONLY: 'false', DAMWHA_CLI_LAUNCHER: '' })).toBe(false);
  });
  it('disabled in demo', () => {
    expect(integrationsEnabled({ HOST: '127.0.0.1', DEMO_READ_ONLY: 'true', DAMWHA_CLI_LAUNCHER: L })).toBe(false);
  });
  it('disabled on 0.0.0.0', () => {
    expect(integrationsEnabled({ HOST: '0.0.0.0', DEMO_READ_ONLY: 'false', DAMWHA_CLI_LAUNCHER: L })).toBe(false);
  });
});
