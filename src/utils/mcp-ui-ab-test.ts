import { configManager } from '../config-manager.js';
import { getABTestVariant } from './ab-test.js';
import { capture } from './capture.js';
import { featureFlagManager } from './feature-flags.js';

export const MCP_UI_EXPERIMENT_NAME = 'McpUiPreviews';
export const MCP_UI_SHOW_VARIANT = 'showMCPUi';
export const MCP_UI_HIDE_VARIANT = 'notShowMCPUi';

export type ExplicitMcpUiChoice = boolean | undefined;

export async function resolveExplicitMcpUiChoice(
  raw: unknown,
  fallback: () => Promise<boolean>,
): Promise<boolean> {
  return typeof raw === 'boolean' ? raw : fallback();
}

export interface McpUiPreviewDecisionDeps {
  getExistingAssignment: () => Promise<unknown>;
  isFirstRun: () => boolean;
  wasLoadedFromCache: () => boolean;
  waitForFreshFlags: () => Promise<void>;
  getABTestVariant: (experimentName: string) => Promise<string | null>;
  capture: (event: string, properties?: Record<string, unknown>) => Promise<unknown> | unknown;
}

function variantEnablesMcpUi(variant: unknown): boolean | null {
  if (variant === MCP_UI_HIDE_VARIANT) return false;
  if (variant === MCP_UI_SHOW_VARIANT) return true;
  return null;
}

export async function resolveMcpUiPreviewDecision(deps: McpUiPreviewDecisionDeps): Promise<boolean> {
  try {
    const existingAssignment = await deps.getExistingAssignment();
    const existingDecision = variantEnablesMcpUi(existingAssignment);
    if (existingDecision !== null) {
      if (!deps.wasLoadedFromCache()) {
        await deps.waitForFreshFlags();
      }

      const currentVariant = await deps.getABTestVariant(MCP_UI_EXPERIMENT_NAME);
      return variantEnablesMcpUi(currentVariant) ?? existingDecision;
    }

    if (!deps.isFirstRun()) {
      return true;
    }

    if (!deps.wasLoadedFromCache()) {
      await deps.waitForFreshFlags();
    }

    const variant = await deps.getABTestVariant(MCP_UI_EXPERIMENT_NAME);
    const decision = variantEnablesMcpUi(variant);
    if (decision === null) {
      return true;
    }

    try {
      await deps.capture('server_mcp_ui_ab_decision', {
        experiment: MCP_UI_EXPERIMENT_NAME,
        variant,
        mcp_ui_enabled: decision,
      });
    } catch {
      // Telemetry must not change the assigned product experience.
    }

    return decision;
  } catch {
    return true;
  }
}

let mcpUiPreviewDecision: Promise<boolean> | undefined;

export function shouldShowMcpUiPreviews(): Promise<boolean> {
  mcpUiPreviewDecision ??= (async () => {
    const explicitChoice = await configManager.getValue('showMcpUI');
    return resolveExplicitMcpUiChoice(explicitChoice, () => resolveMcpUiPreviewDecision({
      getExistingAssignment: () => configManager.getValue(`abTest_${MCP_UI_EXPERIMENT_NAME}`),
      isFirstRun: () => configManager.isFirstRun(),
      wasLoadedFromCache: () => featureFlagManager.wasLoadedFromCache(),
      waitForFreshFlags: () => featureFlagManager.waitForFreshFlags(),
      getABTestVariant,
      capture,
    }));
  })();
  return mcpUiPreviewDecision;
}
