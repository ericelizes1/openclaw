/**
 * Cross-Session Memory Plugin
 *
 * Provides short-term memory across sessions for the same agent.
 * When you switch between Discord channels (each a separate session),
 * this plugin injects recent messages from other channels as context.
 *
 * Hooks:
 * - message_received: Cache incoming messages to shared file
 * - before_agent_start: Read cache and inject as prependContext
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";

// ============================================================================
// Types
// ============================================================================

type CachedMessage = {
  timestamp: number;
  sessionKey: string;
  channelId?: string;
  from?: string;
  content: string;
};

type MessageCache = {
  messages: CachedMessage[];
  lastPruned: number;
};

// ============================================================================
// Config Schema
// ============================================================================

const configSchema = Type.Object({
  /** How far back to look for messages (minutes) */
  cacheMinutes: Type.Optional(Type.Number({ default: 30 })),
  /** Max messages to inject */
  maxMessages: Type.Optional(Type.Number({ default: 20 })),
  /** Max characters to inject */
  maxChars: Type.Optional(Type.Number({ default: 2000 })),
  /** Channel IDs to exclude (e.g., log channels) */
  excludeChannels: Type.Optional(Type.Array(Type.String())),
  /** Only include channels in this list (if set) */
  includeChannels: Type.Optional(Type.Array(Type.String())),
});

type PluginConfig = {
  cacheMinutes?: number;
  maxMessages?: number;
  maxChars?: number;
  excludeChannels?: string[];
  includeChannels?: string[];
};

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_CACHE_MINUTES = 30;
const DEFAULT_MAX_MESSAGES = 20;
const DEFAULT_MAX_CHARS = 2000;
const CACHE_FILENAME = ".cross-session-cache.json";

// ============================================================================
// Cache Operations
// ============================================================================

function getCachePath(workspaceDir: string): string {
  return path.join(workspaceDir, CACHE_FILENAME);
}

async function loadCache(cachePath: string): Promise<MessageCache> {
  try {
    const content = await fs.readFile(cachePath, "utf-8");
    return JSON.parse(content) as MessageCache;
  } catch {
    return { messages: [], lastPruned: Date.now() };
  }
}

async function saveCache(cachePath: string, cache: MessageCache): Promise<void> {
  await fs.writeFile(cachePath, JSON.stringify(cache, null, 2), "utf-8");
}

function pruneCache(cache: MessageCache, maxAgeMs: number): MessageCache {
  const cutoff = Date.now() - maxAgeMs;
  return {
    messages: cache.messages.filter((m) => m.timestamp > cutoff),
    lastPruned: Date.now(),
  };
}

function formatAge(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) {
    return "just now";
  }
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  return `${Math.floor(hours / 24)}d ago`;
}

// ============================================================================
// Plugin
// ============================================================================

const crossSessionMemoryPlugin = {
  id: "cross-session-memory",
  name: "Cross-Session Memory",
  description: "Short-term memory across sessions for the same agent",
  kind: "context",
  configSchema,

  register(api: OpenClawPluginApi) {
    const pluginConfig = (api.pluginConfig ?? {}) as PluginConfig;
    const cacheMinutes = pluginConfig.cacheMinutes ?? DEFAULT_CACHE_MINUTES;
    const maxMessages = pluginConfig.maxMessages ?? DEFAULT_MAX_MESSAGES;
    const maxChars = pluginConfig.maxChars ?? DEFAULT_MAX_CHARS;
    const excludeChannels = pluginConfig.excludeChannels ?? [];
    const includeChannels = pluginConfig.includeChannels;

    // ========================================================================
    // Helper: Find agent by channel binding
    // ========================================================================
    function findAgentByChannel(channelId: string | undefined): { id: string; workspace: string } | undefined {
      if (!channelId) return undefined;
      
      // Check bindings first
      const bindings = api.config.bindings ?? [];
      for (const binding of bindings) {
        const peer = binding.match?.peer;
        if (peer?.kind === "channel" && peer?.id === channelId) {
          const agentId = binding.agentId;
          const agentConfig = api.config.agents?.list?.find((a) => a.id === agentId);
          if (agentConfig?.workspace) {
            return { id: agentId, workspace: agentConfig.workspace };
          }
        }
      }
      
      // Check broadcast config
      const broadcast = api.config.broadcast as Record<string, unknown> | undefined;
      if (broadcast && channelId in broadcast) {
        const agents = broadcast[channelId];
        if (Array.isArray(agents) && agents.length > 0) {
          // Use first agent in broadcast list
          const agentId = agents[0];
          const agentConfig = api.config.agents?.list?.find((a) => a.id === agentId);
          if (agentConfig?.workspace) {
            return { id: agentId, workspace: agentConfig.workspace };
          }
        }
      }
      
      return undefined;
    }

    // ========================================================================
    // message_received hook: Cache incoming messages
    // ========================================================================
    api.on("message_received", async (event, ctx) => {
      // Skip if no content
      if (!event.content?.trim()) {
        return;
      }

      // Skip commands
      if (event.content.trim().startsWith("/")) {
        return;
      }

      // Get workspace directory from channel binding
      const channelId = ctx.conversationId;
      const agentInfo = findAgentByChannel(channelId);
      const workspaceDir = agentInfo?.workspace ?? api.config.agents?.defaults?.workspace;

      if (!workspaceDir) {
        api.logger.warn?.("cross-session-memory: no workspace found for channel " + channelId);
        return;
      }

      // Check channel filters
      if (channelId) {
        if (excludeChannels.includes(channelId)) {
          return;
        }
        if (includeChannels && !includeChannels.includes(channelId)) {
          return;
        }
      }

      api.logger.info?.(`cross-session-memory: caching message from ${event.from} in ${workspaceDir}`);
      const cachePath = getCachePath(workspaceDir);
      const cache = await loadCache(cachePath);

      // Prune old messages
      const maxAgeMs = cacheMinutes * 60 * 1000;
      const prunedCache = pruneCache(cache, maxAgeMs);

      // Add new message
      // Construct a pseudo-session key from channel info since message_received doesn't have sessionKey
      const pseudoSessionKey = agentInfo?.id && channelId
        ? `agent:${agentInfo.id}:discord:channel:${channelId}`
        : channelId ?? "unknown";
      
      const newMessage: CachedMessage = {
        timestamp: event.timestamp ?? Date.now(),
        sessionKey: pseudoSessionKey,
        channelId: ctx.conversationId,
        from: event.from,
        content: event.content.trim(),
      };

      prunedCache.messages.push(newMessage);

      // Keep only recent messages (cache more than we inject)
      const cacheLimit = maxMessages * 3;
      if (prunedCache.messages.length > cacheLimit) {
        prunedCache.messages = prunedCache.messages.slice(-cacheLimit);
      }

      await saveCache(cachePath, prunedCache);
    });

    // ========================================================================
    // before_agent_start hook: Inject cross-session context
    // ========================================================================
    api.on("before_agent_start", async (_event, ctx) => {
      // Get workspace directory from config
      const agentConfig = api.config.agents?.list?.find(
        (a) => ctx.sessionKey?.includes(`agent:${a.id}:`)
      );
      const workspaceDir = ctx.workspaceDir ?? agentConfig?.workspace ?? api.config.agents?.defaults?.workspace;

      if (!workspaceDir) {
        return;
      }

      const cachePath = getCachePath(workspaceDir);
      const cache = await loadCache(cachePath);

      // Prune old messages
      const maxAgeMs = cacheMinutes * 60 * 1000;
      const prunedCache = pruneCache(cache, maxAgeMs);

      // Filter to messages from OTHER sessions
      const currentSessionKey = ctx.sessionKey;
      const otherSessionMessages = prunedCache.messages.filter(
        (m) => m.sessionKey !== currentSessionKey
      );

      if (otherSessionMessages.length === 0) {
        return;
      }

      // Sort by timestamp (newest last)
      otherSessionMessages.sort((a, b) => a.timestamp - b.timestamp);

      // Take most recent messages up to limit
      const recentMessages = otherSessionMessages.slice(-maxMessages);

      // Format messages
      const formattedMessages: string[] = [];
      let totalChars = 0;

      for (const msg of recentMessages) {
        const age = Date.now() - msg.timestamp;
        const ageStr = formatAge(age);

        // Extract channel ID from session key if not directly available
        const channelMatch = msg.sessionKey.match(/channel:(\d+)/);
        const channelId = channelMatch?.[1] ?? msg.channelId ?? "unknown";

        // Truncate long messages
        const content =
          msg.content.length > 200 ? msg.content.slice(0, 197) + "..." : msg.content;

        const line = `[#${channelId} ${ageStr}] ${msg.from ?? "User"}: ${content}`;

        if (totalChars + line.length > maxChars) {
          break;
        }

        formattedMessages.push(line);
        totalChars += line.length;
      }

      if (formattedMessages.length === 0) {
        return;
      }

      const prependContext = [
        "## Recent Activity (Other Channels)",
        "The following messages were received in other channels recently:",
        "",
        ...formattedMessages,
        "",
      ].join("\n");

      api.logger.info?.(`cross-session-memory: injecting ${formattedMessages.length} messages`);

      return { prependContext };
    });
  },
};

export default crossSessionMemoryPlugin;
