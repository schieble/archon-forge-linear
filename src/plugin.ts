#!/usr/bin/env bun
/**
 * The executable Archon runs: `plugin metadata`, or `plugin op <operation>` with one JSON
 * request on stdin and one JSON response on stdout (Archon forge protocol 1). The host passes
 * the key named in the metadata's token_env (LINEAR_API_KEY) as ARCHON_FORGE_TOKEN.
 */
import { forgeRequestSchema, type ForgeResponse } from './contract/operations.ts';
import { handleOperation, linearPluginMetadata } from './handler.ts';
import { LinearGraphql } from './linear-graphql.ts';

function refuse(operationId: string, kind: 'invalid_request' | 'no_credential', message: string): ForgeResponse {
  return { operationId, ok: false, error: { kind, message } };
}

export async function runLinearPlugin(args: readonly string[]): Promise<number> {
  if (args.length === 1 && args[0] === 'metadata') {
    console.log(JSON.stringify(linearPluginMetadata));
    return 0;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(await Bun.stdin.text()) as unknown;
  } catch {
    console.log(JSON.stringify(refuse('invalid', 'invalid_request', 'stdin must contain one UTF-8 JSON request')));
    return 1;
  }
  const operationId =
    typeof raw === 'object' && raw !== null && 'operationId' in raw && typeof raw.operationId === 'string' && raw.operationId !== ''
      ? raw.operationId
      : 'invalid';
  const request = forgeRequestSchema.safeParse(raw);
  if (!request.success) {
    console.log(JSON.stringify(refuse(operationId, 'invalid_request', 'stdin does not match the forge request schema')));
    return 1;
  }
  if (args.length !== 2 || args[0] !== 'op' || args[1] !== request.data.op) {
    console.log(JSON.stringify(refuse(operationId, 'invalid_request', `expected executable arguments: op ${request.data.op}`)));
    return 1;
  }
  const key = process.env.ARCHON_FORGE_TOKEN?.trim();
  if (!key) {
    console.log(JSON.stringify(refuse(operationId, 'no_credential', 'no Linear API key: set LINEAR_API_KEY in the environment Archon runs with')));
    return 1;
  }
  const response = await handleOperation(request.data, new LinearGraphql(key));
  console.log(JSON.stringify(response));
  return response.ok ? 0 : 1;
}

if (import.meta.main) process.exitCode = await runLinearPlugin(process.argv.slice(2));
