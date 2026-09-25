import * as crypto from 'crypto';
import * as vscode from 'vscode';

const TOKEN_KEY = 'agentOffice.token';
/** Token só de visualização (modo navegador): não autoriza hooks. */
export const VIEW_TOKEN_KEY = 'agentOffice.viewToken';

/**
 * Token por sessão: gerado na ativação, guardado em SecretStorage,
 * exportado como AGENT_OFFICE_TOKEN para o hook interpolar no header.
 * Requisição sem o token correto é rejeitada com 401.
 */
export async function getOrCreateToken(context: vscode.ExtensionContext, key = TOKEN_KEY): Promise<string> {
  const existing = await context.secrets.get(key);
  if (existing) {
    return existing;
  }
  const token = crypto.randomBytes(32).toString('hex');
  await context.secrets.store(key, token);
  return token;
}

export function isAuthorized(authorizationHeader: string | undefined, token: string): boolean {
  if (!authorizationHeader) {
    return false;
  }
  const expected = `Bearer ${token}`;
  // Comparação em tempo constante para não vazar o token por timing.
  const a = Buffer.from(authorizationHeader);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
