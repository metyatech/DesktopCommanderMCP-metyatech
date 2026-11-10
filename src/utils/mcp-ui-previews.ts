import { configManager } from '../config-manager.js';

export type McpUiPreviewSettingReader = () => Promise<unknown>;

export async function resolveMcpUiPreviewDecision(
  readSetting: McpUiPreviewSettingReader,
): Promise<boolean> {
  try {
    return (await readSetting()) === true;
  } catch {
    return false;
  }
}

export function createMemoizedMcpUiPreviewDecision(readSetting: McpUiPreviewSettingReader): () => Promise<boolean> {
  let decision: Promise<boolean> | undefined;
  return () => {
    decision ??= resolveMcpUiPreviewDecision(readSetting);
    return decision;
  };
}

export const shouldShowMcpUiPreviews = createMemoizedMcpUiPreviewDecision(
  () => configManager.getValue('showMcpUI'),
);
