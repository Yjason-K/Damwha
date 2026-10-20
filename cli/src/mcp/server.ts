import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { VERSION } from '../version';
import { registerCompleteLens, registerReadTools, type McpDeps } from './tools';

export type { McpDeps } from './tools';

/**
 * 도구 등록은 한 곳에서만 한다. complete_lens(elicitation이 있는 클라이언트에만 노출)는
 * initialize 이후에 이 server에 추가로 등록한다.
 */
export function createMcpServer(deps: McpDeps): McpServer {
  const server = new McpServer({ name: 'damwha', version: VERSION });
  registerReadTools(server, deps);
  server.server.oninitialized = () => {
    // 클라이언트 capability는 initialize가 끝나야 알 수 있다. form 방식 elicitation이 없으면
    // 확인 창을 띄울 수 없으므로 complete_lens를 아예 노출하지 않는다.
    const el = server.server.getClientCapabilities()?.elicitation;
    if (!el || (el.url && !el.form && Object.keys(el).length === 1)) return;
    registerCompleteLens(server, deps);
    // 이미 연결된 뒤의 registerTool이 알림을 보내지만, 명시적으로 한 번 더 보장한다.
    server.sendToolListChanged();
    console.error('damwha-mcp: elicitation supported, complete_lens enabled');
  };
  return server;
}

/**
 * stdio로 서빙하고 연결이 닫힐 때까지 기다린다. stdout은 프로토콜 프레임 전용이라
 * 진단은 stderr로만 낸다.
 */
export async function serveStdio(server: McpServer): Promise<void> {
  const transport = new StdioServerTransport();
  const closed = new Promise<void>((resolve) => {
    server.server.onclose = () => resolve();
  });
  // 클라이언트가 stdin을 닫으면 SDK는 알아채지 못하므로 우리가 닫는다.
  process.stdin.once('end', () => void server.close());
  await server.connect(transport);
  await closed;
}
