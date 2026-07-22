import { app } from "../../../scripts/app.js";

/*
 * ComfyUI Visual Slot Reorder - 1.0.0 public API companion
 *
 * Public API cleanup companion for ComfyUI Visual Slot Reorder stable builds.
 * Purpose: keep user-facing behavior unchanged while moving diagnostic and
 * maintenance helpers out of the enumerable public API surface.
 *
 * This file does not modify workflows, node properties, slots, links,
 * execution order, save/load hooks, drag/drop behavior, menus, panels, or UI.
 * It only changes JavaScript property descriptors on window.ReorderNodes and
 * creates hidden developer namespaces under window.ReorderNodes.__dev.
 */

const EXT_VERSION = "1.0.0";
const NS = "ComfyUI.VisualSlotReorder.PublicApiCleanup";

const GROUPS = {
  diagnostics: [
    "buildCompatibilityPolicyReport",
    "reportCompatibilityPolicy",
    "showCompatibilityPolicyReport",
    "copyCompatibilityPolicyReport",

    "buildWorkflowSafetyScanReport",
    "reportWorkflowSafetyScan",
    "showWorkflowSafetyScan",
    "copyWorkflowSafetyScanReport",

    "reportSlotOrderMetadata",
    "showSlotOrderMetadataReport",
    "copySlotOrderMetadataReport",

    "reportSelectedNodeInfo",
    "showSelectedNodeInfo",
    "copySelectedNodeInfo",

    "reportNodeVsrPolicy",

    // Optional compatibility helpers, hidden if present.
    "showLegacySlotOrderMetadataReport",
    "copyLegacySlotOrderMetadataReport",
    "buildLegacySlotOrderMetadataReport",
    "formatLegacySlotOrderMetadataReport",
  ],

  maintenance: [
    "cleanSlotOrderMetadata",
    "cleanSlotOrderMetadataWithConfirmation",

    "getLegacySlotOrderMetadataStatus",
    "reportLegacySlotOrderMetadata",
    "dryRunCleanLegacySlotOrderMetadata",
    "cleanLegacySlotOrderMetadata",
  ],

  policy: [
    "setNodeVsrPolicy",
    "clearNodeVsrPolicy",
    "applySelectedNodePolicy",

    "disableSelectedNodeInputReorder",
    "disableSelectedNodeOutputReorder",
    "enableSelectedNodeInputReorder",
    "enableSelectedNodeOutputReorder",

    "clearSelectedNodeVsrPolicy",
    "clearSelectedNodeInputVsrPolicy",
    "clearSelectedNodeOutputVsrPolicy",
  ],
};

function ensureApi() {
  if (!window.ReorderNodes || typeof window.ReorderNodes !== "object") return null;
  return window.ReorderNodes;
}

function defineHiddenValue(target, name, value) {
  const existing = Object.getOwnPropertyDescriptor(target, name);
  if (existing && !existing.configurable) return false;
  Object.defineProperty(target, name, {
    value,
    enumerable: false,
    configurable: true,
    writable: true,
  });
  return true;
}

function ensureHiddenNamespace(target, name) {
  const current = target[name];
  if (current && typeof current === "object") {
    const desc = Object.getOwnPropertyDescriptor(target, name);
    if (!desc || desc.enumerable) {
      try {
        Object.defineProperty(target, name, {
          value: current,
          enumerable: false,
          configurable: true,
          writable: true,
        });
      } catch (_) {
        // Keep existing namespace usable even if descriptor cannot be changed.
      }
    }
    return current;
  }

  const ns = {};
  defineHiddenValue(target, name, ns);
  return ns;
}

function makeRootPropertyNonEnumerable(api, name) {
  const desc = Object.getOwnPropertyDescriptor(api, name);
  if (!desc) return { name, ok: false, reason: "missing" };
  if (!desc.enumerable) return { name, ok: true, reason: "already_hidden" };
  if (!desc.configurable) return { name, ok: false, reason: "not_configurable" };

  try {
    Object.defineProperty(api, name, {
      ...desc,
      enumerable: false,
    });
    return { name, ok: true, reason: "hidden" };
  } catch (error) {
    return { name, ok: false, reason: error?.message || "define_property_failed" };
  }
}

function aliasFunction(target, name, value) {
  if (typeof value !== "function") return false;
  const desc = Object.getOwnPropertyDescriptor(target, name);
  if (desc && !desc.configurable) return false;

  Object.defineProperty(target, name, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
  return true;
}

function applyPublicApiCleanup() {
  const api = ensureApi();
  if (!api) {
    return {
      version: EXT_VERSION,
      ok: false,
      reason: "window.ReorderNodes_not_ready",
      hiddenRootProperties: [],
      aliases: {},
      failed: [],
      visibleRootKeys: [],
    };
  }

  const dev = ensureHiddenNamespace(api, "__dev");
  const cleanupNs = ensureHiddenNamespace(dev, "publicApiCleanup");

  const summary = {
    version: EXT_VERSION,
    ok: true,
    reason: "applied",
    hiddenRootProperties: [],
    aliases: {},
    failed: [],
    visibleRootKeys: [],
  };

  for (const [groupName, names] of Object.entries(GROUPS)) {
    const groupNs = ensureHiddenNamespace(dev, groupName);
    summary.aliases[groupName] = [];

    for (const name of names) {
      const value = api[name];
      if (typeof value === "function") {
        if (aliasFunction(groupNs, name, value)) {
          summary.aliases[groupName].push(name);
        }
      }

      const hidden = makeRootPropertyNonEnumerable(api, name);
      if (hidden.ok && hidden.reason !== "missing") {
        summary.hiddenRootProperties.push(name);
      } else if (!hidden.ok && hidden.reason !== "missing") {
        summary.failed.push(hidden);
      }
    }
  }

  summary.visibleRootKeys = Object.keys(api).sort();

  Object.defineProperty(cleanupNs, "version", {
    value: EXT_VERSION,
    enumerable: true,
    configurable: true,
    writable: false,
  });

  Object.defineProperty(cleanupNs, "groups", {
    value: { ...GROUPS },
    enumerable: true,
    configurable: true,
    writable: false,
  });

  Object.defineProperty(cleanupNs, "lastSummary", {
    value: summary,
    enumerable: true,
    configurable: true,
    writable: true,
  });

  Object.defineProperty(cleanupNs, "apply", {
    value: applyPublicApiCleanup,
    enumerable: true,
    configurable: true,
    writable: false,
  });

  Object.defineProperty(cleanupNs, "getStatus", {
    value: () => ({
      version: EXT_VERSION,
      visibleRootKeys: Object.keys(api).sort(),
      diagnostics: Object.keys(dev.diagnostics || {}).sort(),
      maintenance: Object.keys(dev.maintenance || {}).sort(),
      policy: Object.keys(dev.policy || {}).sort(),
      failed: summary.failed.slice(),
    }),
    enumerable: true,
    configurable: true,
    writable: false,
  });

  return summary;
}

function scheduleCleanupPasses() {
  // Finite retries only. This handles uncertain load order between reorder_nodes.js
  // and optional maintenance companions without creating persistent listeners/timers.
  const delays = [0, 50, 250, 1000, 2000];
  for (const delay of delays) {
    window.setTimeout(() => {
      try {
        applyPublicApiCleanup();
      } catch (error) {
        // No startup noise. The developer can inspect __dev.publicApiCleanup if needed.
        void error;
      }
    }, delay);
  }
}

app.registerExtension({
  name: NS,
  setup() {
    scheduleCleanupPasses();
  },
});
