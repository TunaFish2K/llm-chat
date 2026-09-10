import { StoreError } from "./errors";
import type { ConnectionRecord, ContextMessageRecord, ContextGenerationStep, GenerationRecord, AgentSnapshot } from "./generation-types";
import { DEFAULT_AGENT_SYSTEM_PROMPT, effectiveModelId, resolveGenerationPlan } from "./generation-policy";
import { repairTerminalToolCalls } from "./database-repair";
import { migrateOfflineHistory } from "./offline-history";
import { legacyToolPresentation } from "./tool-presentation";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { migrateServiceSettings } from "./service-settings-migration";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import type {
  AgentDto,
  AgentExecutionConfig,
  AgentSearchProvider,
  AgentSearchSecretDto,
  AgentInput,
  AgentRoleplayConfig,
  AgentSummaryDto,
  AppSettings,
  AppSettingsUpdate,
  BalanceConfig,
  CharacterCardV2,
  ConnectionDto,
  ConnectionInput,
  ContextPolicy,
  ContextSummaryDto,
  ConversationForkDto,
  ForkConversationInput,
  ConversationStartedDto,
  ConversationDto,
  ConversationExecutionOverrides,
  ConversationRoleplayState,
  GenerationCreatedDto,
  GenerationDto,
  GenerationSettings,
  GeneratedModelDto,
  FileAssetDto,
  ImageAssetDto,
  ImageGenerationInput,
  ImageGenerationJobDto,
  ImageGenerationJobStatus,
  MessageDto,
  ModelCatalogMetadata,
  ModelDto,
  ModelInput,
  ModelSettings,
  McpServerDto,
  McpServerInput,
  ProviderProtocol,
  RoleplayGenerationTrigger,
  ToolCallDto,
  ToolSettingsDto,
  ToolSettingsInput,
  UsageDto,
  VisionAnalysisDto
} from "@llm-chat/contracts";
import {
  agentExecutionConfigSchema,
  agentSearchConfigSchema,
  agentRoleplayConfigSchema,
  agentUserProfileOverrideSchema,
  balanceConfigSchema,
  characterCardV2Schema,
  conversationExecutionOverridesSchema,
  conversationRoleplayStateSchema,
  generationSettingsSchema,
  greetingMessageSchema,
  modelCatalogMetadataSchema,
  modelCapabilitiesSchema,
  modelSettingsSchema,
  imageGenerationInputSchema,
  imageGenerationJobStatusSchema,
  imageGenerationOperationSchema,
  imageProviderProtocolSchema,
  providerPresetIdSchema,
  reasoningEffortSchema
} from "@llm-chat/contracts";
import { fallbackModel } from "./model-catalog";
import {
  defaultRoleplayConfig,
  ensureRoleplayDefaults,
  parseRoleplayConfig,
  resolveRoleplayState
} from "./roleplay";
import { applySafeRegex, validateSafeRegex } from "./safe-regex";

export interface FileAssetRecord extends FileAssetDto {
  storageKey: string;
}

export interface ImageAssetRecord extends ImageAssetDto {
  storageKey: string;
}

const DEFAULT_COMMAND_SKILL_ID = "command-execution-guide";
const DEFAULT_APP_OPERATOR_SKILL_ID = "llm-chat-operator";
const APP_TOOL_NAMES = [
  "app_agents", "app_conversations", "app_settings", "app_connections", "app_models",
  "app_mcp_servers", "app_skills", "app_plugins", "app_tool_settings", "app_roleplay"
] as const;

type OptionalInput<T> = { [K in keyof T]?: T[K] | undefined };

export const MIGRATION_V1 = `
CREATE TABLE IF NOT EXISTS app_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  default_model_id TEXT,
  default_context_policy TEXT NOT NULL DEFAULT 'auto',
  theme TEXT NOT NULL DEFAULT 'system',
  default_system_prompt TEXT NOT NULL DEFAULT '',
  reasoning_effort TEXT NOT NULL DEFAULT 'none'
    CHECK (reasoning_effort IN ('none','low','medium','high','xhigh','max'))
);
INSERT OR IGNORE INTO app_settings (id) VALUES (1);

CREATE TABLE IF NOT EXISTS connections (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  provider_id TEXT NOT NULL DEFAULT 'custom',
  protocol TEXT NOT NULL,
  base_url TEXT NOT NULL,
  api_key TEXT NOT NULL DEFAULT '',
  secret_headers_json TEXT NOT NULL DEFAULT '{}',
  balance_config_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS models (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  model_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  context_window INTEGER,
  max_output_tokens INTEGER NOT NULL,
  capabilities_json TEXT NOT NULL,
  default_settings_json TEXT NOT NULL,
  source TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(connection_id, model_key)
);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  system_prompt TEXT NOT NULL DEFAULT '',
  context_policy TEXT NOT NULL DEFAULT 'auto',
  draft TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  role TEXT NOT NULL,
  text TEXT,
  active_generation_id TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(conversation_id, ordinal)
);

CREATE TABLE IF NOT EXISTS generations (
  id TEXT PRIMARY KEY,
  assistant_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  status TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  connection_name TEXT NOT NULL,
  protocol TEXT NOT NULL,
  model_key TEXT NOT NULL,
  settings_json TEXT NOT NULL,
  usage_json TEXT NOT NULL DEFAULT '{}',
  stop_reason TEXT,
  error_code TEXT,
  error_message TEXT,
  context_json TEXT,
  provider_context_json TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  UNIQUE(assistant_message_id, version)
);

CREATE TABLE IF NOT EXISTS generation_blocks (
  id TEXT PRIMARY KEY,
  generation_id TEXT NOT NULL REFERENCES generations(id) ON DELETE CASCADE,
  block_index INTEGER NOT NULL,
  type TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  complete INTEGER NOT NULL DEFAULT 0,
  provider_payload_json TEXT,
  UNIQUE(generation_id, block_index)
);

CREATE TABLE IF NOT EXISTS context_summaries (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  through_ordinal INTEGER NOT NULL,
  source_fingerprint TEXT NOT NULL,
  text TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  model_key TEXT NOT NULL,
  usage_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_models_connection ON models(connection_id);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, ordinal);
CREATE INDEX IF NOT EXISTS idx_generations_message ON generations(assistant_message_id, version);
CREATE INDEX IF NOT EXISTS idx_blocks_generation ON generation_blocks(generation_id, block_index);
CREATE INDEX IF NOT EXISTS idx_summaries_conversation ON context_summaries(conversation_id, through_ordinal DESC);
`;

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

function migrate(sqlite: DatabaseSyncType): void {
  const current = Number((sqlite.prepare("PRAGMA user_version").get() as Row).user_version);
  // v40 only added submission receipts. Keep that table and version intact during rollback.
  if (current > 40) throw new Error(`数据库版本 ${current} 高于当前服务支持的版本`);
  sqlite.exec("BEGIN IMMEDIATE");
  try {
    sqlite.exec(MIGRATION_V1);
    if (current < 2) {
      if (!hasColumn(sqlite, "conversations", "model_id")) {
        sqlite.exec("ALTER TABLE conversations ADD COLUMN model_id TEXT REFERENCES models(id) ON DELETE SET NULL");
      }
      if (!hasColumn(sqlite, "generations", "model_display_name")) {
        sqlite.exec("ALTER TABLE generations ADD COLUMN model_display_name TEXT");
      }
      sqlite.exec(`
        UPDATE generations
        SET model_display_name = COALESCE(
          (SELECT display_name FROM models WHERE models.id = generations.model_id),
          model_key
        )
        WHERE model_display_name IS NULL OR model_display_name = '';
        UPDATE conversations
        SET model_id = (
          SELECT default_model_id FROM app_settings
          WHERE id = 1 AND default_model_id IN (SELECT id FROM models WHERE enabled = 1)
        )
        WHERE model_id IS NULL;
        CREATE INDEX IF NOT EXISTS idx_conversations_model ON conversations(model_id);
        PRAGMA user_version = 2;
      `);
    }
    if (current < 3) {
      if (!hasColumn(sqlite, "conversations", "reasoning_effort")) {
        sqlite.exec(`
          ALTER TABLE conversations
            ADD COLUMN reasoning_effort TEXT NULL DEFAULT NULL
            CHECK (reasoning_effort IS NULL
                OR reasoning_effort IN ('low','medium','high','max'));
        `);
      }
      sqlite.exec("PRAGMA user_version = 3;");
    }
    if (current < 4) {
      if (!hasColumn(sqlite, "app_settings", "reasoning_effort")) {
        sqlite.exec(`
          ALTER TABLE app_settings
            ADD COLUMN reasoning_effort TEXT NOT NULL DEFAULT 'none'
            CHECK (reasoning_effort IN ('none','low','medium','high','xhigh','max'));
        `);
      }
      sqlite.exec("PRAGMA user_version = 4;");
    }
    if (current < 5) {
      sqlite.exec(`
        CREATE TABLE IF NOT EXISTS generation_tool_calls (
          id TEXT PRIMARY KEY,
          generation_id TEXT NOT NULL REFERENCES generations(id) ON DELETE CASCADE,
          call_index INTEGER NOT NULL,
          step_index INTEGER NOT NULL DEFAULT 0,
          name TEXT NOT NULL,
          arguments_json TEXT NOT NULL DEFAULT '{}',
          approval_state TEXT NOT NULL DEFAULT 'auto',
          requires_approval INTEGER NOT NULL DEFAULT 0,
          output TEXT,
          error TEXT,
          started_at INTEGER,
          completed_at INTEGER,
          UNIQUE(generation_id, id)
        );
        CREATE INDEX IF NOT EXISTS idx_tool_calls_generation
          ON generation_tool_calls(generation_id, call_index);

        CREATE TABLE IF NOT EXISTS tool_settings (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          enabled_json TEXT NOT NULL DEFAULT '{}',
          search_base_url TEXT NOT NULL DEFAULT '',
          search_api_key TEXT NOT NULL DEFAULT '',
          workspace_shell_enabled INTEGER NOT NULL DEFAULT 0
        );
        INSERT OR IGNORE INTO tool_settings (id) VALUES (1);

        CREATE TABLE IF NOT EXISTS memories (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          content TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE VIRTUAL TABLE IF NOT EXISTS message_search USING fts5(
          message_id UNINDEXED,
          conversation_id UNINDEXED,
          title,
          content,
          tokenize = 'unicode61'
        );
        INSERT INTO message_search (message_id, conversation_id, title, content)
        SELECT m.id, m.conversation_id, c.title,
          CASE WHEN m.role = 'user' THEN COALESCE(m.text, '') ELSE COALESCE((
            SELECT GROUP_CONCAT(b.content, '') FROM generation_blocks b
            JOIN generations g ON g.id = b.generation_id
            WHERE g.id = m.active_generation_id AND b.type IN ('text', 'refusal')
          ), '') END
        FROM messages m JOIN conversations c ON c.id = m.conversation_id;
        PRAGMA user_version = 5;
      `);
    }
    if (current < 6) {
      if (!hasColumn(sqlite, "generation_tool_calls", "step_index")) {
        sqlite.exec("ALTER TABLE generation_tool_calls ADD COLUMN step_index INTEGER NOT NULL DEFAULT 0");
      }
      sqlite.exec(`
        CREATE TABLE IF NOT EXISTS generation_steps (
          generation_id TEXT NOT NULL REFERENCES generations(id) ON DELETE CASCADE,
          step_index INTEGER NOT NULL,
          provider_context_json TEXT,
          PRIMARY KEY (generation_id, step_index)
        );
        PRAGMA user_version = 6;
      `);
    }
    if (current < 7) {
      sqlite.exec(`
        CREATE TABLE IF NOT EXISTS mcp_servers (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          url TEXT NOT NULL,
          headers_json TEXT NOT NULL DEFAULT '{}',
          enabled INTEGER NOT NULL DEFAULT 1,
          last_error TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        PRAGMA user_version = 7;
      `);
    }
    if (current < 8) {
      if (!hasColumn(sqlite, "app_settings", "sidebar_collapsed")) {
        sqlite.exec("ALTER TABLE app_settings ADD COLUMN sidebar_collapsed INTEGER NOT NULL DEFAULT 0");
      }
      if (!hasColumn(sqlite, "app_settings", "reasoning_collapse_policy")) {
        sqlite.exec("ALTER TABLE app_settings ADD COLUMN reasoning_collapse_policy TEXT NOT NULL DEFAULT 'collapse-on-answer'");
      }
      sqlite.exec("PRAGMA user_version = 8;");
    }
    if (current < 9) {
      sqlite.exec(`
        UPDATE models SET capabilities_json = json_set(capabilities_json, '$.tools', json('true'))
        WHERE json_extract(capabilities_json, '$.tools') IS NULL;
        PRAGMA user_version = 9;
      `);
    }
    if (current < 10) {
      sqlite.exec(`
        UPDATE models SET capabilities_json = json_set(capabilities_json, '$.tools', json('true'))
        WHERE json_type(capabilities_json, '$.tools') = 'integer'
          AND json_extract(capabilities_json, '$.tools') = 1;
        PRAGMA user_version = 10;
      `);
    }
    if (current < 11) {
      sqlite.exec(`
        CREATE TABLE IF NOT EXISTS agents (
          id TEXT PRIMARY KEY,
          card_json TEXT NOT NULL,
          execution_json TEXT NOT NULL,
          user_profile_json TEXT NOT NULL DEFAULT '{}',
          avatar_png BLOB,
          protected INTEGER NOT NULL DEFAULT 0,
          revision INTEGER NOT NULL DEFAULT 1,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_agents_updated ON agents(updated_at DESC);
      `);
      if (!hasColumn(sqlite, "conversations", "agent_id")) {
        sqlite.exec("ALTER TABLE conversations ADD COLUMN agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL");
      }
      if (!hasColumn(sqlite, "conversations", "execution_overrides_json")) {
        sqlite.exec("ALTER TABLE conversations ADD COLUMN execution_overrides_json TEXT NOT NULL DEFAULT '{}'");
      }
      if (!hasColumn(sqlite, "generations", "agent_id")) {
        sqlite.exec("ALTER TABLE generations ADD COLUMN agent_id TEXT");
      }
      if (!hasColumn(sqlite, "generations", "agent_name")) {
        sqlite.exec("ALTER TABLE generations ADD COLUMN agent_name TEXT");
      }
      if (!hasColumn(sqlite, "generations", "agent_revision")) {
        sqlite.exec("ALTER TABLE generations ADD COLUMN agent_revision INTEGER");
      }
      if (!hasColumn(sqlite, "generations", "agent_snapshot_json")) {
        sqlite.exec("ALTER TABLE generations ADD COLUMN agent_snapshot_json TEXT");
      }
      if (!hasColumn(sqlite, "app_settings", "default_agent_id")) {
        sqlite.exec("ALTER TABLE app_settings ADD COLUMN default_agent_id TEXT");
      }
      if (!hasColumn(sqlite, "app_settings", "last_agent_id")) {
        sqlite.exec("ALTER TABLE app_settings ADD COLUMN last_agent_id TEXT");
      }
      if (!hasColumn(sqlite, "app_settings", "user_display_name")) {
        sqlite.exec("ALTER TABLE app_settings ADD COLUMN user_display_name TEXT NOT NULL DEFAULT '用户'");
      }
      if (!hasColumn(sqlite, "app_settings", "user_description")) {
        sqlite.exec("ALTER TABLE app_settings ADD COLUMN user_description TEXT NOT NULL DEFAULT ''");
      }
      sqlite.exec(`
        UPDATE conversations
        SET execution_overrides_json = json_object(
          'modelId', model_id,
          'contextPolicy', context_policy
        )
        WHERE execution_overrides_json = '{}';
        CREATE INDEX IF NOT EXISTS idx_conversations_agent ON conversations(agent_id);
        PRAGMA user_version = 11;
      `);
    }
    if (current < 12) {
      if (!hasColumn(sqlite, "conversations", "workspace_path")) {
        sqlite.exec("ALTER TABLE conversations ADD COLUMN workspace_path TEXT");
      }
      if (!hasColumn(sqlite, "app_settings", "last_workspace_path")) {
        sqlite.exec("ALTER TABLE app_settings ADD COLUMN last_workspace_path TEXT");
      }
      sqlite.exec(`
        CREATE TABLE IF NOT EXISTS plugin_installations (
          id TEXT PRIMARY KEY,
          manifest_json TEXT NOT NULL,
          source_path TEXT NOT NULL,
          active_revision TEXT NOT NULL,
          state TEXT NOT NULL DEFAULT 'unloaded',
          error TEXT,
          config_json TEXT NOT NULL DEFAULT '{}',
          secrets_json TEXT NOT NULL DEFAULT '{}',
          installed_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS plugin_revisions (
          plugin_id TEXT NOT NULL REFERENCES plugin_installations(id) ON DELETE CASCADE,
          revision TEXT NOT NULL,
          path TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (plugin_id, revision)
        );
        CREATE TABLE IF NOT EXISTS skill_installations (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          source_path TEXT NOT NULL,
          active_revision TEXT NOT NULL,
          state TEXT NOT NULL DEFAULT 'loaded',
          error TEXT,
          required_tools_json TEXT NOT NULL DEFAULT '[]',
          recommended_approvals_json TEXT NOT NULL DEFAULT '{}',
          bundled INTEGER NOT NULL DEFAULT 0,
          installed_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS skill_revisions (
          skill_id TEXT NOT NULL REFERENCES skill_installations(id) ON DELETE CASCADE,
          revision TEXT NOT NULL,
          path TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (skill_id, revision)
        );
        CREATE TABLE IF NOT EXISTS background_tasks (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          generation_id TEXT NOT NULL REFERENCES generations(id) ON DELETE CASCADE,
          agent_id TEXT,
          agent_name TEXT NOT NULL,
          agent_revision INTEGER NOT NULL,
          command TEXT NOT NULL,
          mode TEXT NOT NULL,
          workspace_path TEXT NOT NULL,
          status TEXT NOT NULL,
          expected_duration_ms INTEGER,
          hard_timeout_ms INTEGER,
          log_limit_bytes INTEGER,
          output_cursor INTEGER NOT NULL DEFAULT 0,
          earliest_cursor INTEGER NOT NULL DEFAULT 0,
          pid INTEGER,
          process_group_id INTEGER,
          process_start_identity TEXT,
          exit_code INTEGER,
          error TEXT,
          created_at INTEGER NOT NULL,
          started_at INTEGER,
          completed_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_background_tasks_conversation ON background_tasks(conversation_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_background_tasks_agent_status ON background_tasks(agent_id, status, created_at);
        CREATE TABLE IF NOT EXISTS background_task_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id TEXT NOT NULL REFERENCES background_tasks(id) ON DELETE CASCADE,
          type TEXT NOT NULL,
          reason TEXT,
          data_json TEXT NOT NULL DEFAULT '{}',
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_background_task_events_task ON background_task_events(task_id, id);
        PRAGMA user_version = 12;
      `);
    }
    if (current < 13) {
      repairTerminalToolCalls(sqlite, Date.now());
      sqlite.exec("PRAGMA user_version = 13;");
    }
    if (current < 14) {
      if (!hasColumn(sqlite, "connections", "balance_config_json")) {
        sqlite.exec("ALTER TABLE connections ADD COLUMN balance_config_json TEXT NOT NULL DEFAULT '{}'");
      }
      repairAnthropicUsage(sqlite, "generations", "protocol = 'anthropic-messages'");
      repairAnthropicUsage(sqlite, "context_summaries", `EXISTS (
        SELECT 1 FROM connections
        WHERE connections.id = context_summaries.connection_id
          AND connections.protocol = 'anthropic-messages'
      )`);
      sqlite.exec("PRAGMA user_version = 14;");
    }
    if (current < 15) {
      if (!hasColumn(sqlite, "skill_installations", "source_kind")) {
        sqlite.exec("ALTER TABLE skill_installations ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'manual'");
      }
      if (!hasColumn(sqlite, "skill_installations", "compatibility")) {
        sqlite.exec("ALTER TABLE skill_installations ADD COLUMN compatibility TEXT");
      }
      sqlite.exec(`
        UPDATE skill_installations
        SET source_kind = CASE WHEN bundled = 1 THEN 'bundled' ELSE 'manual' END
        WHERE source_kind IS NULL OR source_kind != 'agents';
        PRAGMA user_version = 15;
      `);
    }
    if (current < 16) {
      sqlite.exec(`
        CREATE TABLE IF NOT EXISTS auth_owner (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          user_handle TEXT NOT NULL
        );
        INSERT OR IGNORE INTO auth_owner (id, user_handle)
        VALUES (1, lower(hex(randomblob(32))));

        CREATE TABLE IF NOT EXISTS auth_credentials (
          id TEXT PRIMARY KEY,
          credential_id TEXT NOT NULL UNIQUE,
          public_key BLOB NOT NULL,
          counter INTEGER NOT NULL DEFAULT 0,
          transports_json TEXT NOT NULL DEFAULT '[]',
          device_type TEXT NOT NULL,
          backed_up INTEGER NOT NULL DEFAULT 0,
          name TEXT NOT NULL,
          approved_by TEXT REFERENCES auth_credentials(id) ON DELETE SET NULL,
          created_at INTEGER NOT NULL,
          last_used_at INTEGER NOT NULL,
          revoked_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_auth_credentials_active
          ON auth_credentials(revoked_at, last_used_at DESC);

        CREATE TABLE IF NOT EXISTS auth_sessions (
          id TEXT PRIMARY KEY,
          credential_id TEXT NOT NULL REFERENCES auth_credentials(id) ON DELETE CASCADE,
          token_hash TEXT NOT NULL UNIQUE,
          created_at INTEGER NOT NULL,
          last_used_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          revoked_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_auth_sessions_active
          ON auth_sessions(token_hash, revoked_at, expires_at);

        CREATE TABLE IF NOT EXISTS auth_enrollment_requests (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL CHECK (kind IN ('bootstrap', 'device')),
          status TEXT NOT NULL CHECK (status IN ('created', 'awaiting_approval', 'approved', 'redeemed', 'expired')),
          device_name TEXT NOT NULL,
          registration_challenge TEXT,
          tab_secret_hash TEXT,
          approval_secret_hash TEXT NOT NULL,
          pending_credential_id TEXT,
          pending_public_key BLOB,
          pending_counter INTEGER,
          pending_transports_json TEXT,
          pending_device_type TEXT,
          pending_backed_up INTEGER,
          approval_challenge TEXT,
          approved_by TEXT REFERENCES auth_credentials(id) ON DELETE SET NULL,
          request_ip TEXT,
          user_agent TEXT,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          approved_at INTEGER,
          consumed_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_auth_enrollment_active
          ON auth_enrollment_requests(kind, status, expires_at);

        CREATE TABLE IF NOT EXISTS auth_challenges (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL CHECK (kind = 'login'),
          challenge TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL
        );
        PRAGMA user_version = 16;
      `);
    }
    if (current < 17) {
      sqlite.exec(`
        CREATE TABLE IF NOT EXISTS auth_password (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          salt BLOB NOT NULL,
          password_hash BLOB NOT NULL,
          changed_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS auth_password_sessions (
          id TEXT PRIMARY KEY,
          token_hash TEXT NOT NULL UNIQUE,
          created_at INTEGER NOT NULL,
          last_used_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          revoked_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_auth_password_sessions_active
          ON auth_password_sessions(token_hash, revoked_at, expires_at);
        PRAGMA user_version = 17;
      `);
    }
    if (current < 18) {
      if (!hasColumn(sqlite, "conversations", "parent_conversation_id")) {
        sqlite.exec("ALTER TABLE conversations ADD COLUMN parent_conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL");
      }
      if (!hasColumn(sqlite, "conversations", "forked_from_message_id")) {
        sqlite.exec("ALTER TABLE conversations ADD COLUMN forked_from_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL");
      }
      if (!hasColumn(sqlite, "generation_tool_calls", "provider_id")) {
        sqlite.exec("ALTER TABLE generation_tool_calls ADD COLUMN provider_id TEXT");
      }
      sqlite.exec(`
        UPDATE generation_tool_calls SET provider_id = id WHERE provider_id IS NULL OR provider_id = '';
        CREATE INDEX IF NOT EXISTS idx_conversations_parent ON conversations(parent_conversation_id);
        PRAGMA user_version = 18;
      `);
    }
    if (current < 19) {
      if (!hasColumn(sqlite, "generation_blocks", "step_index")) {
        sqlite.exec("ALTER TABLE generation_blocks ADD COLUMN step_index INTEGER NOT NULL DEFAULT 0");
      }
      sqlite.exec(`
        UPDATE generation_blocks SET step_index = CAST(block_index / 1000 AS INTEGER);
        UPDATE models SET capabilities_json = json_set(capabilities_json, '$.imageInput', json('false'))
        WHERE json_extract(capabilities_json, '$.imageInput') IS NULL;

        CREATE TABLE IF NOT EXISTS image_assets (
          id TEXT PRIMARY KEY,
          sha256 TEXT NOT NULL UNIQUE,
          file_name TEXT NOT NULL,
          mime_type TEXT NOT NULL,
          byte_size INTEGER NOT NULL,
          storage_key TEXT NOT NULL UNIQUE,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS message_image_assets (
          message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
          asset_id TEXT NOT NULL REFERENCES image_assets(id) ON DELETE CASCADE,
          asset_index INTEGER NOT NULL,
          PRIMARY KEY (message_id, asset_id),
          UNIQUE (message_id, asset_index)
        );
        CREATE INDEX IF NOT EXISTS idx_message_images_asset ON message_image_assets(asset_id);

        CREATE TABLE IF NOT EXISTS tool_call_image_assets (
          tool_call_id TEXT NOT NULL REFERENCES generation_tool_calls(id) ON DELETE CASCADE,
          asset_id TEXT NOT NULL REFERENCES image_assets(id) ON DELETE CASCADE,
          asset_index INTEGER NOT NULL,
          PRIMARY KEY (tool_call_id, asset_id),
          UNIQUE (tool_call_id, asset_index)
        );
        CREATE INDEX IF NOT EXISTS idx_tool_images_asset ON tool_call_image_assets(asset_id);

        CREATE TABLE IF NOT EXISTS vision_analyses (
          id TEXT PRIMARY KEY,
          asset_id TEXT NOT NULL REFERENCES image_assets(id) ON DELETE CASCADE,
          cache_key TEXT NOT NULL UNIQUE,
          status TEXT NOT NULL,
          model_id TEXT NOT NULL,
          model_display_name TEXT NOT NULL,
          model_key TEXT NOT NULL,
          connection_name TEXT NOT NULL,
          protocol TEXT NOT NULL,
          description TEXT,
          usage_json TEXT NOT NULL DEFAULT '{}',
          error TEXT,
          created_at INTEGER NOT NULL,
          completed_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_vision_asset ON vision_analyses(asset_id, created_at DESC);

        CREATE TABLE IF NOT EXISTS generation_vision_analyses (
          generation_id TEXT NOT NULL REFERENCES generations(id) ON DELETE CASCADE,
          analysis_id TEXT NOT NULL REFERENCES vision_analyses(id) ON DELETE CASCADE,
          analysis_index INTEGER NOT NULL,
          cached INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (generation_id, analysis_id),
          UNIQUE (generation_id, analysis_index)
        );
        PRAGMA user_version = 19;
      `);
      sqlite.prepare(`
        UPDATE app_settings SET default_system_prompt = ?
        WHERE id = 1 AND trim(default_system_prompt) = ''
      `).run(DEFAULT_AGENT_SYSTEM_PROMPT);
    }
    if (current < 20) {
      if (!hasColumn(sqlite, "models", "max_input_tokens")) {
        sqlite.exec("ALTER TABLE models ADD COLUMN max_input_tokens INTEGER");
      }
      if (!hasColumn(sqlite, "models", "catalog_managed")) {
        sqlite.exec("ALTER TABLE models ADD COLUMN catalog_managed INTEGER NOT NULL DEFAULT 0");
      }
      if (!hasColumn(sqlite, "models", "catalog_metadata_json")) {
        sqlite.exec("ALTER TABLE models ADD COLUMN catalog_metadata_json TEXT");
      }
      if (!hasColumn(sqlite, "messages", "greeting_json")) {
        sqlite.exec("ALTER TABLE messages ADD COLUMN greeting_json TEXT");
      }
      sqlite.exec("PRAGMA user_version = 20;");
    }
    if (current < 21) {
      sqlite.exec(`
        CREATE TABLE IF NOT EXISTS file_blobs (
          sha256 TEXT PRIMARY KEY,
          byte_size INTEGER NOT NULL,
          storage_key TEXT NOT NULL UNIQUE,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS file_assets (
          id TEXT PRIMARY KEY,
          sha256 TEXT NOT NULL REFERENCES file_blobs(sha256) ON DELETE RESTRICT,
          file_name TEXT NOT NULL,
          mime_type TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('image', 'file')),
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_file_assets_sha ON file_assets(sha256);
        INSERT OR IGNORE INTO file_blobs (sha256, byte_size, storage_key, created_at)
          SELECT sha256, byte_size, storage_key, created_at FROM image_assets;
        INSERT OR IGNORE INTO file_assets (id, sha256, file_name, mime_type, kind, created_at)
          SELECT id, sha256, file_name, mime_type, 'image', created_at FROM image_assets;

        CREATE TABLE IF NOT EXISTS message_file_assets (
          message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
          asset_id TEXT NOT NULL REFERENCES file_assets(id) ON DELETE CASCADE,
          asset_index INTEGER NOT NULL,
          PRIMARY KEY (message_id, asset_id),
          UNIQUE (message_id, asset_index)
        );
        CREATE INDEX IF NOT EXISTS idx_message_files_asset ON message_file_assets(asset_id);
        INSERT OR IGNORE INTO message_file_assets SELECT * FROM message_image_assets;

        CREATE TABLE IF NOT EXISTS tool_call_file_assets (
          tool_call_id TEXT NOT NULL REFERENCES generation_tool_calls(id) ON DELETE CASCADE,
          asset_id TEXT NOT NULL REFERENCES file_assets(id) ON DELETE CASCADE,
          asset_index INTEGER NOT NULL,
          PRIMARY KEY (tool_call_id, asset_id),
          UNIQUE (tool_call_id, asset_index)
        );
        CREATE INDEX IF NOT EXISTS idx_tool_files_asset ON tool_call_file_assets(asset_id);
        INSERT OR IGNORE INTO tool_call_file_assets SELECT * FROM tool_call_image_assets;

        CREATE TABLE vision_analyses_v21 (
          id TEXT PRIMARY KEY,
          asset_id TEXT NOT NULL REFERENCES file_assets(id) ON DELETE CASCADE,
          cache_key TEXT NOT NULL UNIQUE,
          status TEXT NOT NULL,
          model_id TEXT NOT NULL,
          model_display_name TEXT NOT NULL,
          model_key TEXT NOT NULL,
          connection_name TEXT NOT NULL,
          protocol TEXT NOT NULL,
          description TEXT,
          usage_json TEXT NOT NULL DEFAULT '{}',
          error TEXT,
          created_at INTEGER NOT NULL,
          completed_at INTEGER
        );
        INSERT INTO vision_analyses_v21 SELECT * FROM vision_analyses;
        CREATE TABLE generation_vision_analyses_v21 (
          generation_id TEXT NOT NULL REFERENCES generations(id) ON DELETE CASCADE,
          analysis_id TEXT NOT NULL REFERENCES vision_analyses_v21(id) ON DELETE CASCADE,
          analysis_index INTEGER NOT NULL,
          cached INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (generation_id, analysis_id),
          UNIQUE (generation_id, analysis_index)
        );
        INSERT INTO generation_vision_analyses_v21 SELECT * FROM generation_vision_analyses;
        DROP TABLE generation_vision_analyses;
        DROP TABLE vision_analyses;
        ALTER TABLE vision_analyses_v21 RENAME TO vision_analyses;
        ALTER TABLE generation_vision_analyses_v21 RENAME TO generation_vision_analyses;
        CREATE INDEX IF NOT EXISTS idx_vision_asset_v21 ON vision_analyses(asset_id, created_at DESC);
        PRAGMA user_version = 21;
      `);
    }
    if (current < 22) {
      sqlite.exec("PRAGMA user_version = 22;");
    }
    if (current < 23) {
      if (!hasColumn(sqlite, "conversations", "fork_mode")) {
        sqlite.exec("ALTER TABLE conversations ADD COLUMN fork_mode TEXT CHECK (fork_mode IS NULL OR fork_mode IN ('edit','continue','greeting'))");
      }
      if (!hasColumn(sqlite, "conversations", "fork_point_ordinal")) {
        sqlite.exec("ALTER TABLE conversations ADD COLUMN fork_point_ordinal INTEGER");
      }
      if (!hasColumn(sqlite, "conversations", "fork_greeting_index")) {
        sqlite.exec("ALTER TABLE conversations ADD COLUMN fork_greeting_index INTEGER");
      }
      if (!hasColumn(sqlite, "conversations", "fork_source_greeting_index")) {
        sqlite.exec("ALTER TABLE conversations ADD COLUMN fork_source_greeting_index INTEGER");
      }
      sqlite.exec(`
        UPDATE conversations
        SET fork_point_ordinal = (
          SELECT ordinal FROM messages WHERE messages.id = conversations.forked_from_message_id
        )
        WHERE parent_conversation_id IS NOT NULL AND forked_from_message_id IS NOT NULL;

        UPDATE conversations
        SET fork_source_greeting_index = (
          SELECT CAST(json_extract(messages.greeting_json, '$.activeIndex') AS INTEGER)
          FROM messages
          WHERE messages.id = conversations.forked_from_message_id
            AND messages.greeting_json IS NOT NULL
            AND json_valid(messages.greeting_json)
        )
        WHERE parent_conversation_id IS NOT NULL;

        UPDATE conversations
        SET fork_greeting_index = (
          SELECT CAST(json_extract(messages.greeting_json, '$.activeIndex') AS INTEGER)
          FROM messages
          WHERE messages.conversation_id = conversations.id
            AND messages.ordinal = 1
            AND messages.greeting_json IS NOT NULL
            AND json_valid(messages.greeting_json)
        )
        WHERE parent_conversation_id IS NOT NULL;

        UPDATE conversations
        SET fork_mode = CASE
          WHEN forked_from_message_id IS NULL THEN 'continue'
          WHEN fork_source_greeting_index IS NOT NULL
            AND fork_greeting_index IS NOT NULL
            AND fork_source_greeting_index != fork_greeting_index THEN 'greeting'
          WHEN (SELECT role FROM messages WHERE messages.id = conversations.forked_from_message_id) = 'user' THEN 'edit'
          ELSE 'continue'
        END
        WHERE parent_conversation_id IS NOT NULL;
        PRAGMA user_version = 23;
      `);
    }
    if (current < 24) {
      if (!hasColumn(sqlite, "agents", "roleplay_json")) {
        sqlite.exec("ALTER TABLE agents ADD COLUMN roleplay_json TEXT NOT NULL DEFAULT '{}'");
      }
      if (!hasColumn(sqlite, "app_settings", "generation_haptics")) {
        sqlite.exec("ALTER TABLE app_settings ADD COLUMN generation_haptics INTEGER NOT NULL DEFAULT 1");
      }
      if (!hasColumn(sqlite, "generations", "generation_kind")) {
        sqlite.exec(`ALTER TABLE generations ADD COLUMN generation_kind TEXT NOT NULL DEFAULT 'normal'
          CHECK (generation_kind IN ('normal','continue','regenerate','script'))`);
      }
      sqlite.exec(`
        CREATE TABLE IF NOT EXISTS conversation_agent_roleplay_states (
          conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
          state_json TEXT NOT NULL DEFAULT '{}',
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (conversation_id, agent_id)
        );
        CREATE INDEX IF NOT EXISTS idx_roleplay_states_agent
          ON conversation_agent_roleplay_states(agent_id, updated_at DESC);
        PRAGMA user_version = 24;
      `);
    }
    if (current < 25) {
      sqlite.exec(`
        CREATE TABLE IF NOT EXISTS agent_file_assets (
          agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
          asset_id TEXT NOT NULL REFERENCES file_assets(id) ON DELETE CASCADE,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (agent_id, asset_id)
        );
        CREATE INDEX IF NOT EXISTS idx_agent_file_assets_asset ON agent_file_assets(asset_id);
        PRAGMA user_version = 25;
      `);
    }
    if (current < 26) {
      sqlite.exec(`
        CREATE TABLE IF NOT EXISTS roleplay_script_audit (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
          source_kind TEXT NOT NULL,
          source_id TEXT,
          command_count INTEGER NOT NULL,
          success INTEGER NOT NULL,
          error TEXT,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_roleplay_script_audit_conversation
          ON roleplay_script_audit(conversation_id, created_at DESC);
        PRAGMA user_version = 26;
      `);
    }
    if (current < 27) {
      sqlite.exec(`
        CREATE TABLE IF NOT EXISTS agent_search_secrets (
          agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
          provider TEXT NOT NULL CHECK (provider IN ('searxng', 'tavily')),
          api_key TEXT NOT NULL DEFAULT '',
          PRIMARY KEY (agent_id, provider)
        );
        PRAGMA user_version = 27;
      `);
    }
    if (current < 28) {
      if (!hasColumn(sqlite, "connections", "provider_id")) {
        sqlite.exec("ALTER TABLE connections ADD COLUMN provider_id TEXT NOT NULL DEFAULT 'custom'");
      }
      sqlite.exec("PRAGMA user_version = 28");
    }
    if (current < 29) {
      if (!hasColumn(sqlite, "models", "image_protocol")) {
        sqlite.exec("ALTER TABLE models ADD COLUMN image_protocol TEXT");
      }
      sqlite.exec(`
        CREATE TABLE IF NOT EXISTS image_generation_jobs (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          assistant_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
          tool_call_id TEXT,
          model_id TEXT NOT NULL REFERENCES models(id) ON DELETE CASCADE,
          connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
          model_key TEXT NOT NULL,
          connection_name TEXT NOT NULL,
          image_protocol TEXT NOT NULL,
          operation TEXT NOT NULL,
          prompt TEXT NOT NULL,
          request_json TEXT NOT NULL,
          status TEXT NOT NULL,
          progress REAL,
          provider_job_id TEXT,
          output_asset_ids_json TEXT NOT NULL DEFAULT '[]',
          revised_prompt TEXT,
          error_code TEXT,
          error_message TEXT,
          created_at INTEGER NOT NULL,
          started_at INTEGER,
          completed_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_image_jobs_conversation ON image_generation_jobs(conversation_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_image_jobs_status ON image_generation_jobs(status, created_at);
        PRAGMA user_version = 29;
      `);
    }
    if (current < 30) {
      sqlite.exec(`
        CREATE TABLE IF NOT EXISTS conversation_family_state (
          root_conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
          active_conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_conversation_family_state_active
          ON conversation_family_state(active_conversation_id);
        INSERT OR IGNORE INTO conversation_family_state (root_conversation_id, active_conversation_id, updated_at)
          SELECT id, id, updated_at FROM conversations WHERE parent_conversation_id IS NULL;
        PRAGMA user_version = 30;
      `);
    }
    if (current < 31) {
      sqlite.exec(`
        CREATE TABLE IF NOT EXISTS codex_sessions (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          thread_id TEXT NOT NULL UNIQUE,
          cwd TEXT NOT NULL,
          preview TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'detached',
          profile TEXT NOT NULL DEFAULT 'server-workspace',
          model TEXT,
          current_turn_id TEXT,
          managed INTEGER NOT NULL DEFAULT 1,
          error TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_codex_sessions_conversation
          ON codex_sessions(conversation_id, updated_at DESC);
        CREATE TABLE IF NOT EXISTS codex_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL REFERENCES codex_sessions(id) ON DELETE CASCADE,
          kind TEXT NOT NULL,
          method TEXT NOT NULL,
          payload_json TEXT NOT NULL DEFAULT '{}',
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_codex_events_session
          ON codex_events(session_id, id);
        PRAGMA user_version = 31;
      `);
    }
    if (current < 32) {
      sqlite.exec(`
        CREATE TABLE IF NOT EXISTS queued_messages (
          id TEXT PRIMARY KEY,
          sequence INTEGER NOT NULL UNIQUE,
          conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          text TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          error TEXT,
          generation_id TEXT REFERENCES generations(id) ON DELETE SET NULL,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_queue_conversation ON queued_messages(conversation_id, sequence);
        CREATE TABLE IF NOT EXISTS queued_message_assets (
          queue_id TEXT NOT NULL REFERENCES queued_messages(id) ON DELETE CASCADE,
          asset_id TEXT NOT NULL REFERENCES file_assets(id),
          asset_index INTEGER NOT NULL,
          PRIMARY KEY(queue_id, asset_id)
        );
        PRAGMA user_version = 32;
      `);
    }
    if (current < 33) {
      if (!hasColumn(sqlite, "messages", "history_active")) sqlite.exec("ALTER TABLE messages ADD COLUMN history_active INTEGER NOT NULL DEFAULT 1");
      if (!hasColumn(sqlite, "conversations", "history_revision")) sqlite.exec("ALTER TABLE conversations ADD COLUMN history_revision INTEGER NOT NULL DEFAULT 0");
      if (!hasColumn(sqlite, "conversations", "queue_paused")) sqlite.exec("ALTER TABLE conversations ADD COLUMN queue_paused INTEGER NOT NULL DEFAULT 0");
      sqlite.exec(`
        CREATE TABLE IF NOT EXISTS global_search_engines (
          id TEXT PRIMARY KEY, provider TEXT NOT NULL, base_url TEXT NOT NULL DEFAULT '',
          api_key TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 0, position INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS image_tool_models (
          model_id TEXT PRIMARY KEY REFERENCES models(id) ON DELETE CASCADE,
          handle TEXT NOT NULL UNIQUE, enabled INTEGER NOT NULL DEFAULT 1, position INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS conversation_history (
          id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          message_ids_json TEXT NOT NULL, redo INTEGER NOT NULL DEFAULT 1,
          sequence INTEGER NOT NULL, created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_history_conversation ON conversation_history(conversation_id, sequence);
        PRAGMA user_version = 33;
      `);
    }
    if (current < 34) {
      if (!hasColumn(sqlite, "app_settings", "accent_color")) sqlite.exec("ALTER TABLE app_settings ADD COLUMN accent_color TEXT");
      if (!hasColumn(sqlite, "app_settings", "amoled")) sqlite.exec("ALTER TABLE app_settings ADD COLUMN amoled INTEGER NOT NULL DEFAULT 0");
      if (!hasColumn(sqlite, "queued_messages", "mode")) sqlite.exec("ALTER TABLE queued_messages ADD COLUMN mode TEXT NOT NULL DEFAULT 'queue'");
      sqlite.exec("PRAGMA user_version = 34");
    }
    if (current < 35) {
      if (!hasColumn(sqlite, "agents", "last_selected_model_id")) {
        sqlite.exec("ALTER TABLE agents ADD COLUMN last_selected_model_id TEXT REFERENCES models(id) ON DELETE SET NULL");
      }
      sqlite.exec("PRAGMA user_version = 35");
    }
    if (current < 36) {
      const settings = sqlite.prepare("SELECT default_system_prompt FROM app_settings WHERE id = 1").get() as Row;
      const update = sqlite.prepare("UPDATE agents SET execution_json = ?, revision = revision + 1 WHERE id = ?");
      for (const row of sqlite.prepare("SELECT id, execution_json FROM agents").all() as Row[]) {
        const execution = parse<Record<string, unknown>>(row.execution_json, {});
        if (!Object.hasOwn(execution, "baseSystemPrompt")) {
          update.run(json({ ...execution, baseSystemPrompt: String(settings.default_system_prompt) }), String(row.id));
        }
      }
      sqlite.exec("PRAGMA user_version = 36");
    }
    if (current < 37) {
      if (!hasColumn(sqlite, "generation_tool_calls", "presentation_json")) sqlite.exec("ALTER TABLE generation_tool_calls ADD COLUMN presentation_json TEXT");
      sqlite.exec("PRAGMA user_version = 37;");
    }
    if (current < 38) {
      for (const [name, value] of [["chat_font_size", 13.5], ["chat_letter_spacing", 0], ["chat_line_height", 1.55]] as const) {
        if (!hasColumn(sqlite, "app_settings", name)) sqlite.exec(`ALTER TABLE app_settings ADD COLUMN ${name} REAL NOT NULL DEFAULT ${value}`);
      }
      sqlite.exec("PRAGMA user_version = 38;");
    }
    if (current < 39) {
      migrateOfflineHistory(sqlite);
      sqlite.exec("PRAGMA user_version = 39;");
    }
    sqlite.exec("COMMIT");
  } catch (error) {
    sqlite.exec("ROLLBACK");
    throw error;
  }
}

function repairAnthropicUsage(sqlite: DatabaseSyncType, table: string, anthropicWhere: string): void {
  sqlite.exec(`
    UPDATE ${table}
    SET usage_json = json_set(
      usage_json,
      '$.inputTokens',
      json_extract(usage_json, '$.inputTokens') + json_extract(usage_json, '$.cachedInputTokens')
    )
    WHERE ${anthropicWhere}
      AND json_valid(usage_json)
      AND json_type(usage_json, '$.inputTokens') IN ('integer', 'real')
      AND json_type(usage_json, '$.cachedInputTokens') IN ('integer', 'real');

    UPDATE ${table}
    SET usage_json = json_set(
      usage_json,
      '$.totalTokens',
      json_extract(usage_json, '$.inputTokens') + json_extract(usage_json, '$.outputTokens')
    )
    WHERE ${anthropicWhere}
      AND json_valid(usage_json)
      AND json_type(usage_json, '$.inputTokens') IN ('integer', 'real')
      AND json_type(usage_json, '$.outputTokens') IN ('integer', 'real');
  `);
}

function hasColumn(sqlite: DatabaseSyncType, table: string, column: string): boolean {
  return (sqlite.prepare(`PRAGMA table_info(${table})`).all() as Row[])
    .some((row) => row.name === column);
}

export class Store {
  readonly sqlite: DatabaseSyncType;
  readonly dataDir: string;

  constructor(path: string) {
    this.dataDir = dirname(path);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.sqlite = new DatabaseSync(path, { timeout: 5_000 });
    this.sqlite.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    const priorVersion = Number((this.sqlite.prepare("PRAGMA user_version").get() as Row).user_version);
    migrate(this.sqlite);
    const legacyWorkspace = `${this.dataDir}/workspace`;
    mkdirSync(legacyWorkspace, { recursive: true, mode: 0o700 });
    if (priorVersion < 12) {
      this.sqlite.prepare("UPDATE conversations SET workspace_path = ? WHERE workspace_path IS NULL").run(legacyWorkspace);
    }
    this.migrateLegacyToolPolicy();
    this.ensureDefaultAgent(priorVersion < 19, priorVersion < 22);
    if (priorVersion < 27) this.migrateLegacySearchSettings();
    if (priorVersion < 33) migrateServiceSettings(this.sqlite);
    if (priorVersion < 21) this.migrateAppToolPolicy();
    if (priorVersion < 26) this.migrateRoleplayToolPolicy();
    if (priorVersion < 20) {
      this.backfillLegacyCatalogManagement();
      this.backfillLegacyGreetings();
    }
    try {
      chmodSync(dirname(path), 0o700);
    } catch {
      // Permission modes are best effort on non-POSIX platforms.
    }
    for (const databaseFile of [path, `${path}-wal`, `${path}-shm`]) {
      try {
        chmodSync(databaseFile, 0o600);
      } catch {
        // A sidecar can be absent depending on the SQLite journal state.
      }
    }
  }

  close(): void {
    this.sqlite.close();
  }

  private ensureDefaultAgent(enableCommandSkillOnUpgrade: boolean, enableAppOperatorOnUpgrade: boolean): void {
    const settings = this.sqlite.prepare("SELECT * FROM app_settings WHERE id = 1").get() as Row;
    let row = this.sqlite.prepare("SELECT * FROM agents WHERE protected = 1 ORDER BY created_at LIMIT 1").get() as Row | undefined;
    if (!row) {
      const id = randomUUID();
      const now = Date.now();
      const modelId = textOrNull(settings.default_model_id);
      const enabledModel = modelId ? this.getModel(modelId) : undefined;
      const card = defaultAgentCard();
      const execution: AgentExecutionConfig = {
        baseSystemPrompt: String(settings.default_system_prompt),
        modelId: enabledModel?.enabled ? enabledModel.id : null,
        visionModelId: null,
        contextPolicy: settings.default_context_policy as ContextPolicy,
        reasoningEffort: reasoningEffortSchema.parse(settings.reasoning_effort),
        search: agentSearchConfigSchema.parse({}),
        generation: {},
        tools: { defaultEnabled: true, overrides: {}, directOverrides: {}, approvalOverrides: {} },
        enabledSkillIds: [DEFAULT_COMMAND_SKILL_ID, DEFAULT_APP_OPERATOR_SKILL_ID],
        maxToolRounds: 32,
        maxBackgroundTasks: 2,
        taskLogLimitBytes: 64 * 1024 * 1024
      };
      this.sqlite.prepare(`
        INSERT INTO agents (id, card_json, execution_json, user_profile_json, protected, revision, created_at, updated_at)
        VALUES (?, ?, ?, '{}', 1, 1, ?, ?)
      `).run(id, json(card), json(execution), now, now);
      row = this.sqlite.prepare("SELECT * FROM agents WHERE id = ?").get(id) as Row;
    }
    const protectedExecution = agentExecutionConfigSchema.parse(parse(row.execution_json, {}));
    if (enableCommandSkillOnUpgrade && !protectedExecution.enabledSkillIds.includes(DEFAULT_COMMAND_SKILL_ID)) {
      protectedExecution.enabledSkillIds.push(DEFAULT_COMMAND_SKILL_ID);
    }
    if (enableAppOperatorOnUpgrade && !protectedExecution.enabledSkillIds.includes(DEFAULT_APP_OPERATOR_SKILL_ID)) {
      protectedExecution.enabledSkillIds.push(DEFAULT_APP_OPERATOR_SKILL_ID);
    }
    if (
      (enableCommandSkillOnUpgrade || enableAppOperatorOnUpgrade) &&
      JSON.stringify(protectedExecution) !== String(row.execution_json)
    ) {
      this.sqlite.prepare("UPDATE agents SET execution_json = ? WHERE id = ?")
        .run(json(protectedExecution), String(row.id));
      row = this.sqlite.prepare("SELECT * FROM agents WHERE id = ?").get(String(row.id)) as Row;
    }
    const defaultId = String(row.id);
    const priorDefaultId = textOrNull(settings.default_agent_id);
    const validDefault = priorDefaultId && this.getAgent(priorDefaultId) ? priorDefaultId : defaultId;
    const priorLastId = textOrNull(settings.last_agent_id);
    const validLast = priorLastId && this.getAgent(priorLastId) ? priorLastId : validDefault;
    this.sqlite.prepare("UPDATE app_settings SET default_agent_id = ?, last_agent_id = ? WHERE id = 1")
      .run(validDefault, validLast);
    if (!priorDefaultId) {
      this.sqlite.prepare("UPDATE conversations SET agent_id = ? WHERE agent_id IS NULL").run(defaultId);
    }
  }

  private backfillLegacyCatalogManagement(): void {
    for (const model of this.listModels()) {
      if (model.source !== "discovered") continue;
      const connection = this.getConnection(model.connectionId);
      if (!connection) continue;
      const fallback = fallbackModel(model.connectionId, connection.protocol, model.modelKey, model.displayName);
      const untouched = model.contextWindow === null && model.maxOutputTokens === fallback.maxOutputTokens &&
        JSON.stringify(model.capabilities) === JSON.stringify(fallback.capabilities) &&
        JSON.stringify(model.defaultSettings) === JSON.stringify(fallback.defaultSettings);
      if (untouched) {
        this.sqlite.prepare("UPDATE models SET catalog_managed = 1 WHERE id = ?").run(model.id);
      }
    }
  }

  private migrateAppToolPolicy(): void {
    for (const row of this.sqlite.prepare("SELECT id, protected, execution_json FROM agents").all() as Row[]) {
      const execution = agentExecutionConfigSchema.parse(parse(row.execution_json, {}));
      const enabled = Boolean(row.protected);
      execution.tools.overrides = {
        ...execution.tools.overrides,
        ...Object.fromEntries(APP_TOOL_NAMES.map((name) => [name, enabled]))
      };
      if (enabled) {
        execution.tools.directOverrides = {
          ...execution.tools.directOverrides,
          ...Object.fromEntries(APP_TOOL_NAMES.map((name) => [name, false]))
        };
      }
      this.sqlite.prepare("UPDATE agents SET execution_json = ? WHERE id = ?").run(json(execution), String(row.id));
    }
  }

  private migrateRoleplayToolPolicy(): void {
    for (const row of this.sqlite.prepare("SELECT id, protected, execution_json FROM agents").all() as Row[]) {
      const execution = agentExecutionConfigSchema.parse(parse(row.execution_json, {}));
      execution.tools.overrides.app_roleplay = Boolean(row.protected);
      if (row.protected) {
        execution.tools.directOverrides = { ...(execution.tools.directOverrides ?? {}), app_roleplay: false };
      }
      this.sqlite.prepare("UPDATE agents SET execution_json = ? WHERE id = ?").run(json(execution), String(row.id));
    }
  }

  private backfillLegacyGreetings(): void {
    const rows = this.sqlite.prepare(`
      SELECT m.id, m.text, c.agent_id
      FROM messages m JOIN conversations c ON c.id = m.conversation_id
      WHERE m.ordinal = 1 AND m.role = 'assistant' AND m.active_generation_id IS NULL
        AND m.greeting_json IS NULL AND c.agent_id IS NOT NULL
    `).all() as Row[];
    for (const row of rows) {
      const agent = this.getAgent(String(row.agent_id));
      if (!agent) continue;
      const userName = this.resolvedUserProfile(agent).displayName;
      const variants = [agent.card.data.first_mes, ...agent.card.data.alternate_greetings]
        .map((text) => substituteCardPlaceholders(text, agent.name, userName))
        .filter((text) => text.trim().length > 0);
      const activeIndex = variants.findIndex((text) => text === String(row.text ?? ""));
      if (activeIndex < 0) continue;
      const greeting = greetingMessageSchema.parse({
        variants,
        activeIndex,
        agent: { agentId: agent.id, name: agent.name, revision: agent.revision }
      });
      this.sqlite.prepare("UPDATE messages SET greeting_json = ? WHERE id = ?").run(json(greeting), String(row.id));
    }
  }

  private migrateLegacyToolPolicy(): void {
    const row = this.sqlite.prepare("SELECT enabled_json, workspace_shell_enabled FROM tool_settings WHERE id = 1").get() as Row;
    const enabled = parse<Record<string, boolean>>(row.enabled_json, {});
    if (!Boolean(row.workspace_shell_enabled)) enabled.workspace_shell = false;
    const disabled = Object.fromEntries(Object.entries(enabled).filter(([, value]) => value === false));
    if (!Object.keys(disabled).length) return;
    const agents = this.sqlite.prepare("SELECT id, execution_json FROM agents").all() as Row[];
    for (const agent of agents) {
      const raw = parse<Record<string, unknown>>(agent.execution_json, {});
      const tools = (raw.tools && typeof raw.tools === "object" ? raw.tools : {}) as Record<string, unknown>;
      const overrides = (tools.overrides && typeof tools.overrides === "object" ? tools.overrides : {}) as Record<string, boolean>;
      const next = { ...raw, tools: { ...tools, overrides: { ...disabled, ...overrides } } };
      this.sqlite.prepare("UPDATE agents SET execution_json = ? WHERE id = ?").run(json(next), String(agent.id));
    }
    this.sqlite.prepare("UPDATE tool_settings SET enabled_json = '{}', workspace_shell_enabled = 1 WHERE id = 1").run();
  }

  private migrateLegacySearchSettings(): void {
    const row = this.sqlite.prepare("SELECT search_base_url, search_api_key FROM tool_settings WHERE id = 1").get() as Row;
    const baseUrl = String(row.search_base_url ?? "");
    const apiKey = String(row.search_api_key ?? "");
    const insertSecret = this.sqlite.prepare(`
      INSERT INTO agent_search_secrets (agent_id, provider, api_key) VALUES (?, 'searxng', ?)
      ON CONFLICT(agent_id, provider) DO NOTHING
    `);
    const updateAgent = this.sqlite.prepare("UPDATE agents SET execution_json = ? WHERE id = ?");
    for (const agent of this.sqlite.prepare("SELECT id, execution_json FROM agents").all() as Row[]) {
      const raw = parse<Record<string, unknown>>(agent.execution_json, {});
      const search = agentSearchConfigSchema.parse(raw.search ?? { provider: "searxng", baseUrl });
      updateAgent.run(json({ ...raw, search }), String(agent.id));
      if (apiKey) insertSecret.run(String(agent.id), apiKey);
    }
    this.sqlite.prepare("UPDATE tool_settings SET search_base_url = '', search_api_key = '' WHERE id = 1").run();
  }

  getSettings(): AppSettings {
    const row = this.sqlite.prepare("SELECT * FROM app_settings WHERE id = 1").get() as Row;
    return {
      theme: row.theme as AppSettings["theme"],
      defaultAgentId: String(row.default_agent_id),
      lastAgentId: String(row.last_agent_id),
      userProfile: {
        displayName: String(row.user_display_name),
        description: String(row.user_description)
      },
      uiPreferences: {
        sidebarCollapsed: Boolean(row.sidebar_collapsed),
        reasoningCollapsePolicy: row.reasoning_collapse_policy as AppSettings["uiPreferences"]["reasoningCollapsePolicy"],
        generationHaptics: Boolean(row.generation_haptics),
        accentColor: textOrNull(row.accent_color),
        amoled: Boolean(row.amoled),
        chatFontSize: Number(row.chat_font_size),
        chatLetterSpacing: Number(row.chat_letter_spacing),
        chatLineHeight: Number(row.chat_line_height)
      },
      lastWorkspacePath: textOrNull(row.last_workspace_path)
    };
  }

  updateSettings(patch: AppSettingsUpdate): AppSettings {
    const current = this.getSettings();
    const next: AppSettings = {
      theme: patch.theme ?? current.theme,
      defaultAgentId: patch.defaultAgentId ?? current.defaultAgentId,
      lastAgentId: patch.lastAgentId ?? current.lastAgentId,
      userProfile: patch.userProfile ?? current.userProfile,
      uiPreferences: { ...current.uiPreferences, ...Object.fromEntries(Object.entries(patch.uiPreferences ?? {}).filter(([, value]) => value !== undefined)) },
      lastWorkspacePath: patch.lastWorkspacePath === undefined ? current.lastWorkspacePath : patch.lastWorkspacePath
    };
    this.sqlite.prepare(`
      UPDATE app_settings SET theme = ?,
        default_agent_id = ?, last_agent_id = ?, user_display_name = ?, user_description = ?,
        sidebar_collapsed = ?, reasoning_collapse_policy = ?, generation_haptics = ?, last_workspace_path = ?, accent_color = ?, amoled = ?, chat_font_size = ?, chat_letter_spacing = ?, chat_line_height = ?
      WHERE id = 1
    `).run(next.theme,
      next.defaultAgentId, next.lastAgentId, next.userProfile.displayName, next.userProfile.description,
      next.uiPreferences.sidebarCollapsed ? 1 : 0, next.uiPreferences.reasoningCollapsePolicy,
      next.uiPreferences.generationHaptics ? 1 : 0, next.lastWorkspacePath, next.uiPreferences.accentColor ?? null, Number(next.uiPreferences.amoled ?? false),
      next.uiPreferences.chatFontSize ?? 13.5, next.uiPreferences.chatLetterSpacing ?? 0, next.uiPreferences.chatLineHeight ?? 1.55);
    if (patch.userProfile !== undefined) {
      this.sqlite.prepare("DELETE FROM context_summaries").run();
    }
    return next;
  }

  listAgents(): AgentSummaryDto[] {
    return (this.sqlite.prepare("SELECT * FROM agents ORDER BY protected DESC, updated_at DESC").all() as Row[])
      .map((row) => {
        const summary = agentSummaryDto(row);
        return { ...summary, searchApiKeyConfigured: this.hasAgentSearchApiKey(summary.id, summary.execution.search.provider) };
      });
  }

  getAgent(id: string): AgentDto | undefined {
    const row = this.sqlite.prepare("SELECT * FROM agents WHERE id = ?").get(id) as Row | undefined;
    if (!row) return undefined;
    const summary = agentSummaryDto(row);
    return agentDto(row, this.hasAgentSearchApiKey(summary.id, summary.execution.search.provider));
  }

  createAgent(input: AgentInput, avatarPng?: Uint8Array): AgentDto {
    const parsed = {
      card: characterCardV2Schema.parse(input.card),
      execution: agentExecutionConfigSchema.parse({ ...input.execution, baseSystemPrompt: input.execution.baseSystemPrompt ?? DEFAULT_AGENT_SYSTEM_PROMPT }),
      userProfile: agentUserProfileOverrideSchema.parse(input.userProfile),
      roleplay: input.roleplay
        ? ensureRoleplayDefaults(agentRoleplayConfigSchema.parse(input.roleplay))
        : defaultRoleplayConfig(false)
    };
    parsed.execution.tools.overrides = {
      ...parsed.execution.tools.overrides,
      ...Object.fromEntries(APP_TOOL_NAMES.map((name) => [name, false]))
    };
    for (const name of APP_TOOL_NAMES) delete parsed.execution.tools.directOverrides?.[name];
    this.validateAgentModels(parsed.execution);
    this.validateRoleplayScripts(parsed.roleplay);
    const id = randomUUID();
    const now = Date.now();
    this.sqlite.prepare(`
      INSERT INTO agents (id, card_json, execution_json, user_profile_json, roleplay_json, avatar_png, protected, revision, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, 1, ?, ?)
    `).run(id, json(parsed.card), json(parsed.execution), json(parsed.userProfile), json(parsed.roleplay), avatarPng ?? null, now, now);
    return this.getAgent(id)!;
  }

  createAgentCopy(input: AgentInput, avatarPng?: Uint8Array): AgentDto {
    const names = new Set(this.listAgents().map((agent) => agent.name));
    const original = input.card.data.name;
    let name = original;
    for (let index = 2; names.has(name); index += 1) name = `${original} (${index})`;
    return this.createAgent({ ...input, card: { ...input.card, data: { ...input.card.data, name } } }, avatarPng);
  }

  updateAgent(id: string, patch: OptionalInput<AgentInput>): AgentDto | undefined {
    const current = this.getAgent(id);
    if (!current) return undefined;
    const card = characterCardV2Schema.parse(patch.card ?? current.card);
    const execution = agentExecutionConfigSchema.parse({
      ...(patch.execution ?? current.execution),
      baseSystemPrompt: patch.execution?.baseSystemPrompt ?? current.execution.baseSystemPrompt ?? DEFAULT_AGENT_SYSTEM_PROMPT
    });
    const userProfile = agentUserProfileOverrideSchema.parse(patch.userProfile ?? current.userProfile);
    const roleplay = ensureRoleplayDefaults(agentRoleplayConfigSchema.parse(patch.roleplay ?? current.roleplay));
    this.validateAgentModels(execution);
    this.validateRoleplayScripts(roleplay);
    this.sqlite.prepare(`
      UPDATE agents SET card_json = ?, execution_json = ?, user_profile_json = ?, roleplay_json = ?,
        revision = revision + 1, updated_at = ? WHERE id = ?
    `).run(json(card), json(execution), json(userProfile), json(roleplay), Date.now(), id);
    this.sqlite.prepare("DELETE FROM context_summaries WHERE conversation_id IN (SELECT id FROM conversations WHERE agent_id = ?)")
      .run(id);
    return this.getAgent(id);
  }

  getAgentSearchSecret(agentId: string, provider: AgentSearchProvider): string {
    const row = this.sqlite.prepare(
      "SELECT api_key FROM agent_search_secrets WHERE agent_id = ? AND provider = ?"
    ).get(agentId, provider) as Row | undefined;
    return String(row?.api_key ?? "");
  }

  hasAgentSearchApiKey(agentId: string, provider: AgentSearchProvider): boolean {
    return this.getAgentSearchSecret(agentId, provider).length > 0;
  }

  updateAgentSearchSecret(agentId: string, provider: AgentSearchProvider, apiKey: string): AgentSearchSecretDto {
    if (!this.getAgent(agentId)) throw new StoreError("agent_not_found", "Agent 不存在");
    this.sqlite.prepare(`
      INSERT INTO agent_search_secrets (agent_id, provider, api_key) VALUES (?, ?, ?)
      ON CONFLICT(agent_id, provider) DO UPDATE SET api_key = excluded.api_key
    `).run(agentId, provider, apiKey);
    return { provider, hasApiKey: apiKey.length > 0 };
  }

  setAgentAvatar(id: string, avatarPng: Uint8Array | null): AgentDto | undefined {
    const result = this.sqlite.prepare("UPDATE agents SET avatar_png = ?, updated_at = ? WHERE id = ?")
      .run(avatarPng, Date.now(), id);
    return Number(result.changes) ? this.getAgent(id) : undefined;
  }

  getAgentAvatar(id: string): Uint8Array | undefined {
    const row = this.sqlite.prepare("SELECT avatar_png FROM agents WHERE id = ?").get(id) as Row | undefined;
    return row?.avatar_png instanceof Uint8Array ? row.avatar_png : undefined;
  }

  deleteAgent(id: string): boolean {
    const current = this.getAgent(id);
    if (!current) return false;
    if (current.protected) throw new StoreError("agent_protected", "默认助手不能删除");
    const settings = this.getSettings();
    const result = this.sqlite.prepare("DELETE FROM agents WHERE id = ?").run(id);
    if (Number(result.changes) && (settings.defaultAgentId === id || settings.lastAgentId === id)) {
      const protectedAgent = this.sqlite.prepare("SELECT id FROM agents WHERE protected = 1 ORDER BY created_at LIMIT 1").get() as Row;
      const defaultAgentId = settings.defaultAgentId === id ? String(protectedAgent.id) : settings.defaultAgentId;
      const lastAgentId = settings.lastAgentId === id ? defaultAgentId : settings.lastAgentId;
      this.sqlite.prepare("UPDATE app_settings SET default_agent_id = ?, last_agent_id = ? WHERE id = 1")
        .run(defaultAgentId, lastAgentId);
    }
    return Number(result.changes) > 0;
  }

  attachFileToAgent(agentId: string, assetId: string): void {
    if (!this.getAgent(agentId)) throw new StoreError("agent_not_found", "Agent 不存在");
    if (!this.getFileAsset(assetId)) throw new StoreError("file_asset_not_found", "文件资产不存在");
    this.sqlite.prepare(`
      INSERT OR IGNORE INTO agent_file_assets (agent_id, asset_id, created_at) VALUES (?, ?, ?)
    `).run(agentId, assetId, Date.now());
  }

  detachFileFromAgent(agentId: string, assetId: string): void {
    this.sqlite.prepare("DELETE FROM agent_file_assets WHERE agent_id = ? AND asset_id = ?").run(agentId, assetId);
  }

  getConversationRoleplayState(conversationId: string): ConversationRoleplayState {
    const conversation = this.getConversation(conversationId);
    if (!conversation) throw new StoreError("conversation_not_found", "会话不存在");
    if (!conversation.agentId) throw new StoreError("conversation_agent_required", "请先为会话选择 Agent");
    const agent = this.getAgent(conversation.agentId);
    if (!agent) throw new StoreError("conversation_agent_required", "会话当前 Agent 不可用，请重新选择");
    const row = this.sqlite.prepare(`
      SELECT state_json FROM conversation_agent_roleplay_states
      WHERE conversation_id = ? AND agent_id = ?
    `).get(conversationId, agent.id) as Row | undefined;
    return resolveRoleplayState(agent.roleplay, row ? parse(row.state_json, {}) : undefined);
  }

  updateConversationRoleplayState(
    conversationId: string,
    patch: OptionalInput<ConversationRoleplayState>
  ): ConversationRoleplayState {
    const conversation = this.getConversation(conversationId);
    if (!conversation) throw new StoreError("conversation_not_found", "会话不存在");
    if (!conversation.agentId) throw new StoreError("conversation_agent_required", "请先为会话选择 Agent");
    const agent = this.getAgent(conversation.agentId);
    if (!agent) throw new StoreError("conversation_agent_required", "会话当前 Agent 不可用，请重新选择");
    const current = this.getConversationRoleplayState(conversationId);
    const next = resolveRoleplayState(agent.roleplay, conversationRoleplayStateSchema.parse({ ...current, ...patch }));
    this.sqlite.prepare(`
      INSERT INTO conversation_agent_roleplay_states (conversation_id, agent_id, state_json, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(conversation_id, agent_id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at
    `).run(conversationId, agent.id, json(next), Date.now());
    this.sqlite.prepare("DELETE FROM context_summaries WHERE conversation_id = ?").run(conversationId);
    return next;
  }

  recordRoleplayScriptAudit(input: {
    conversationId: string;
    agentId: string;
    sourceKind: "inline" | "quick_reply" | "trigger" | "app_tool";
    sourceId?: string;
    commandCount: number;
    success: boolean;
    error?: string;
  }): void {
    this.sqlite.prepare(`
      INSERT INTO roleplay_script_audit
        (id, conversation_id, agent_id, source_kind, source_id, command_count, success, error, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), input.conversationId, input.agentId, input.sourceKind, input.sourceId ?? null,
      input.commandCount, input.success ? 1 : 0, input.error ?? null, Date.now());
  }

  listRoleplayScriptAudit(conversationId: string): Array<Record<string, unknown>> {
    return (this.sqlite.prepare(`
      SELECT id, conversation_id, agent_id, source_kind, source_id, command_count, success, error, created_at
      FROM roleplay_script_audit WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 200
    `).all(conversationId) as Row[]).map((row) => ({
      id: String(row.id),
      conversationId: String(row.conversation_id),
      agentId: String(row.agent_id),
      sourceKind: String(row.source_kind),
      sourceId: textOrNull(row.source_id),
      commandCount: Number(row.command_count),
      success: Boolean(row.success),
      error: textOrNull(row.error),
      createdAt: Number(row.created_at)
    }));
  }

  private cloneRoleplayStates(sourceConversationId: string, targetConversationId: string): void {
    this.sqlite.prepare(`
      INSERT INTO conversation_agent_roleplay_states (conversation_id, agent_id, state_json, updated_at)
      SELECT ?, agent_id, state_json, ? FROM conversation_agent_roleplay_states WHERE conversation_id = ?
    `).run(targetConversationId, Date.now(), sourceConversationId);
  }

  rememberAgentModel(id: string, modelId: string): AgentDto {
    if (!this.getAgent(id)) throw new StoreError("agent_not_found", "Agent 不存在");
    this.validateAgentModel(modelId);
    this.sqlite.prepare("UPDATE agents SET last_selected_model_id = ? WHERE id = ?").run(modelId, id);
    return this.getAgent(id)!;
  }

  newConversationOverrides(agentId: string, input: ConversationExecutionOverrides = {}): ConversationExecutionOverrides {
    const agent = this.getAgent(agentId);
    if (!agent) throw new StoreError("agent_not_found", "Agent 不存在");
    const overrides = conversationExecutionOverridesSchema.parse(input);
    if (!Object.hasOwn(overrides, "modelId") && !agent.execution.modelId && agent.lastSelectedModelId) {
      const model = this.getModel(agent.lastSelectedModelId);
      if (model?.enabled) overrides.modelId = model.id;
    }
    return overrides;
  }

  private validateAgentModel(modelId: string | null): void {
    if (!modelId) return;
    const model = this.getModel(modelId);
    if (!model) throw new StoreError("model_not_found", "模型不存在");
    if (!model.enabled) throw new StoreError("model_disabled", "模型已停用");
  }

  private validateAgentModels(execution: Pick<AgentExecutionConfig, "modelId" | "visionModelId">): void {
    this.validateAgentModel(execution.modelId);
    if (!execution.visionModelId) return;
    this.validateAgentModel(execution.visionModelId);
    const visionModel = this.getModel(execution.visionModelId);
    if (!visionModel?.capabilities.imageInput) {
      throw new StoreError("vision_model_capability_required", "备用识图模型必须启用图片输入能力");
    }
  }

  private validateRoleplayScripts(roleplay: AgentRoleplayConfig): void {
    for (const script of roleplay.regexScripts) {
      if (!script.enabled) continue;
      const error = validateSafeRegex(script.pattern, script.flags);
      if (error) throw new StoreError("roleplay_regex_unsafe", `${script.name}: ${error}`);
    }
  }

  getToolSettings(): ToolSettingsDto {
    const row = this.sqlite.prepare("SELECT * FROM tool_settings WHERE id = 1").get() as Row;
    return {
      enabled: parse(row.enabled_json, {}),
      workspaceShellEnabled: Boolean(row.workspace_shell_enabled),
      workspacePath: `${this.dataDir}/workspace`,
      skillsPath: `${this.dataDir}/skills`
    };
  }

  updateToolSettings(patch: ToolSettingsInput): ToolSettingsDto {
    const current = this.getToolSettings();
    this.sqlite.prepare(`
      UPDATE tool_settings SET enabled_json = ?, workspace_shell_enabled = ?
      WHERE id = 1
    `).run(
      json(patch.enabled ?? current.enabled),
      (patch.workspaceShellEnabled ?? current.workspaceShellEnabled) ? 1 : 0
    );
    return this.getToolSettings();
  }

  listMcpServers(): McpServerDto[] {
    return (this.sqlite.prepare("SELECT * FROM mcp_servers ORDER BY name COLLATE NOCASE").all() as Row[]).map(mcpServerDto);
  }

  getMcpServer(id: string): (McpServerDto & { headers: Record<string, string> }) | undefined {
    const row = this.sqlite.prepare("SELECT * FROM mcp_servers WHERE id = ?").get(id) as Row | undefined;
    return row ? { ...mcpServerDto(row), headers: parse(row.headers_json, {}) } : undefined;
  }

  createMcpServer(input: McpServerInput): McpServerDto {
    const id = randomUUID();
    const now = Date.now();
    this.sqlite.prepare(`
      INSERT INTO mcp_servers (id, name, url, headers_json, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, input.name, input.url, json(input.headers), input.enabled ? 1 : 0, now, now);
    return this.listMcpServers().find((item) => item.id === id)!;
  }

  updateMcpServer(id: string, input: OptionalInput<McpServerInput>): McpServerDto | undefined {
    const current = this.getMcpServer(id);
    if (!current) return undefined;
    this.sqlite.prepare(`
      UPDATE mcp_servers SET name = ?, url = ?, headers_json = ?, enabled = ?, last_error = NULL, updated_at = ? WHERE id = ?
    `).run(input.name ?? current.name, input.url ?? current.url, json(input.headers ?? current.headers),
      (input.enabled ?? current.enabled) ? 1 : 0, Date.now(), id);
    return this.listMcpServers().find((item) => item.id === id);
  }

  setMcpServerError(id: string, error: string | null): void {
    this.sqlite.prepare("UPDATE mcp_servers SET last_error = ?, updated_at = ? WHERE id = ?").run(error, Date.now(), id);
  }

  deleteMcpServer(id: string): boolean {
    return Number(this.sqlite.prepare("DELETE FROM mcp_servers WHERE id = ?").run(id).changes) > 0;
  }

  listConnections(): ConnectionDto[] {
    return (this.sqlite.prepare("SELECT * FROM connections ORDER BY name COLLATE NOCASE").all() as Row[])
      .map(connectionDto);
  }

  getConnection(id: string): ConnectionRecord | undefined {
    const row = this.sqlite.prepare("SELECT * FROM connections WHERE id = ?").get(id) as Row | undefined;
    return row ? connectionRecord(row) : undefined;
  }

  createConnection(input: ConnectionInput): ConnectionDto {
    const now = Date.now();
    const id = randomUUID();
    this.sqlite.prepare(`
      INSERT INTO connections (
        id, name, provider_id, protocol, base_url, api_key, secret_headers_json, balance_config_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, input.name, input.providerId ?? "custom", input.protocol, input.baseUrl, input.apiKey ?? "", json(input.secretHeaders ?? {}),
      json(input.balanceConfig ?? {}), now, now
    );
    return this.listConnections().find((item) => item.id === id)!;
  }

  updateConnection(id: string, input: OptionalInput<ConnectionInput>): ConnectionDto | undefined {
    const current = this.getConnection(id);
    if (!current) return undefined;
    const now = Date.now();
    this.sqlite.prepare(`
      UPDATE connections SET name = ?, provider_id = ?, protocol = ?, base_url = ?, api_key = ?, secret_headers_json = ?,
        balance_config_json = ?, updated_at = ?
      WHERE id = ?
    `).run(
      input.name ?? current.name,
      input.providerId ?? current.providerId,
      input.protocol ?? current.protocol,
      input.baseUrl ?? current.baseUrl,
      input.apiKey === undefined ? current.apiKey : input.apiKey,
      json(input.secretHeaders ?? current.secretHeaders),
      json(input.balanceConfig ?? current.balanceConfig ?? {}),
      now,
      id
    );
    return this.listConnections().find((item) => item.id === id);
  }

  deleteConnection(id: string): boolean {
    const result = this.sqlite.prepare("DELETE FROM connections WHERE id = ?").run(id);
    if (Number(result.changes)) {
      this.sqlite.prepare("UPDATE app_settings SET default_model_id = NULL WHERE default_model_id NOT IN (SELECT id FROM models)").run();
    }
    return Number(result.changes) > 0;
  }

  listModels(connectionId?: string): ModelDto[] {
    const rows = connectionId
      ? this.sqlite.prepare("SELECT * FROM models WHERE connection_id = ? ORDER BY display_name COLLATE NOCASE").all(connectionId)
      : this.sqlite.prepare("SELECT * FROM models ORDER BY display_name COLLATE NOCASE").all();
    return (rows as Row[]).map(modelDto);
  }

  getModel(id: string): ModelDto | undefined {
    const row = this.sqlite.prepare("SELECT * FROM models WHERE id = ?").get(id) as Row | undefined;
    return row ? modelDto(row) : undefined;
  }

  createModel(
    input: ModelInput,
    source: ModelDto["source"] = "manual",
    catalogMetadata: ModelCatalogMetadata | null = null,
    catalogManaged = source === "discovered"
  ): ModelDto {
    const now = Date.now();
    const id = randomUUID();
    this.sqlite.prepare(`
      INSERT INTO models (id, connection_id, model_key, display_name, context_window, max_output_tokens, image_protocol,
        capabilities_json, default_settings_json, source, enabled, created_at, updated_at,
        max_input_tokens, catalog_managed, catalog_metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(connection_id, model_key) DO UPDATE SET
        display_name = excluded.display_name,
        catalog_managed = CASE WHEN excluded.source = 'manual' THEN 0 ELSE models.catalog_managed END,
        updated_at = excluded.updated_at
    `).run(
      id, input.connectionId, input.modelKey, input.displayName, input.contextWindow, input.maxOutputTokens, input.imageProtocol ?? null,
      json(input.capabilities), json(input.defaultSettings), source, input.enabled ? 1 : 0, now, now,
      input.maxInputTokens ?? null, catalogManaged ? 1 : 0, catalogMetadata ? json(catalogMetadata) : null
    );
    return this.listModels(input.connectionId).find((item) => item.modelKey === input.modelKey)!;
  }

  upsertDiscoveredModel(
    input: ModelInput,
    catalogMetadata: ModelCatalogMetadata | null
  ): { model: ModelDto; status: "created" | "updated" | "skipped" } {
    const current = this.listModels(input.connectionId).find((model) => model.modelKey === input.modelKey);
    if (!current) {
      return { model: this.createModel(input, "discovered", catalogMetadata, true), status: "created" };
    }
    if (!current.catalogManaged) return { model: current, status: "skipped" };
    // A transient directory failure or unmatched response must not erase metadata
    // from a model that was enriched successfully on an earlier discovery.
    if (!catalogMetadata) return { model: current, status: "skipped" };
    this.writeCatalogModel(current.id, input, catalogMetadata);
    return { model: this.getModel(current.id)!, status: "updated" };
  }

  restoreCatalogModel(id: string, input: ModelInput, catalogMetadata: ModelCatalogMetadata): ModelDto | undefined {
    const current = this.getModel(id);
    if (!current) return undefined;
    this.writeCatalogModel(id, { ...input, enabled: current.enabled }, catalogMetadata);
    return this.getModel(id);
  }

  private writeCatalogModel(id: string, input: ModelInput, catalogMetadata: ModelCatalogMetadata | null): void {
    this.sqlite.prepare(`
      UPDATE models SET display_name = ?, context_window = ?, max_input_tokens = ?, max_output_tokens = ?, image_protocol = ?,
        capabilities_json = ?, default_settings_json = ?, source = 'discovered', catalog_managed = 1,
        catalog_metadata_json = ?, updated_at = ? WHERE id = ?
    `).run(
      input.displayName, input.contextWindow, input.maxInputTokens ?? null, input.maxOutputTokens, input.imageProtocol ?? null,
      json(input.capabilities), json(input.defaultSettings), catalogMetadata ? json(catalogMetadata) : null,
      Date.now(), id
    );
  }

  updateModel(id: string, input: OptionalInput<ModelInput>): ModelDto | undefined {
    const current = this.getModel(id);
    if (!current) return undefined;
    const next: ModelInput = {
      connectionId: input.connectionId ?? current.connectionId,
      modelKey: input.modelKey ?? current.modelKey,
      displayName: input.displayName ?? current.displayName,
      contextWindow: input.contextWindow === undefined ? current.contextWindow : input.contextWindow,
      maxInputTokens: input.maxInputTokens === undefined ? current.maxInputTokens : input.maxInputTokens,
      maxOutputTokens: input.maxOutputTokens ?? current.maxOutputTokens,
      imageProtocol: input.imageProtocol === undefined ? current.imageProtocol : input.imageProtocol,
      capabilities: input.capabilities ?? current.capabilities,
      defaultSettings: input.defaultSettings ?? current.defaultSettings,
      enabled: input.enabled ?? current.enabled
    };
    const metadataChanged = ["connectionId", "modelKey", "displayName", "contextWindow", "maxInputTokens",
      "maxOutputTokens", "imageProtocol", "capabilities", "defaultSettings"].some((key) => Object.hasOwn(input, key));
    this.sqlite.prepare(`
      UPDATE models SET connection_id = ?, model_key = ?, display_name = ?, context_window = ?, max_output_tokens = ?, image_protocol = ?,
        capabilities_json = ?, default_settings_json = ?, enabled = ?, max_input_tokens = ?, catalog_managed = ?,
        updated_at = ? WHERE id = ?
    `).run(
      next.connectionId, next.modelKey, next.displayName, next.contextWindow, next.maxOutputTokens, next.imageProtocol ?? null,
      json(next.capabilities), json(next.defaultSettings), next.enabled ? 1 : 0, next.maxInputTokens ?? null,
      metadataChanged ? 0 : current.catalogManaged ? 1 : 0, Date.now(), id
    );
    if (!next.enabled) {
      this.sqlite.prepare("UPDATE conversations SET model_id = NULL WHERE model_id = ?").run(id);
      this.sqlite.prepare("UPDATE app_settings SET default_model_id = NULL WHERE default_model_id = ?").run(id);
    }
    return this.getModel(id);
  }

  deleteModel(id: string): boolean {
    const result = this.sqlite.prepare("DELETE FROM models WHERE id = ?").run(id);
    this.sqlite.prepare("UPDATE app_settings SET default_model_id = NULL WHERE default_model_id = ?").run(id);
    return Number(result.changes) > 0;
  }

  createFileAsset(input: {
    id?: string;
    sha256: string;
    fileName: string;
    mimeType: string;
    kind: FileAssetDto["kind"];
    byteSize: number;
    storageKey: string;
  }): FileAssetRecord {
    const id = input.id ?? randomUUID();
    const now = Date.now();
    this.sqlite.prepare(`
      INSERT OR IGNORE INTO file_blobs (sha256, byte_size, storage_key, created_at) VALUES (?, ?, ?, ?)
    `).run(input.sha256, input.byteSize, input.storageKey, now);
    this.sqlite.prepare(`
      INSERT INTO file_assets (id, sha256, file_name, mime_type, kind, created_at) VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, input.sha256, input.fileName, input.mimeType, input.kind, now);
    return this.getFileAssetRecord(id)!;
  }

  createImageAsset(input: Omit<Parameters<Store["createFileAsset"]>[0], "kind"> & {
    mimeType: ImageAssetDto["mimeType"];
  }): ImageAssetRecord {
    return this.createFileAsset({ ...input, kind: "image" }) as ImageAssetRecord;
  }

  getFileAsset(id: string): FileAssetDto | undefined {
    const record = this.getFileAssetRecord(id);
    if (!record) return undefined;
    const { storageKey: _storageKey, ...dto } = record;
    return dto;
  }

  getImageAsset(id: string): ImageAssetDto | undefined {
    const asset = this.getFileAsset(id);
    return asset?.kind === "image" ? asset as ImageAssetDto : undefined;
  }

  imageAssetBelongsToConversation(conversationId: string, assetId: string): boolean {
    const row = this.sqlite.prepare(`
      SELECT 1 FROM message_file_assets mfa
      JOIN messages m ON m.id = mfa.message_id
      WHERE m.conversation_id = ? AND mfa.asset_id = ?
      UNION ALL
      SELECT 1 FROM tool_call_file_assets tcfa
      JOIN generation_tool_calls tc ON tc.id = tcfa.tool_call_id
      JOIN generations g ON g.id = tc.generation_id
      JOIN messages m ON m.id = g.assistant_message_id
      WHERE m.conversation_id = ? AND tcfa.asset_id = ?
      LIMIT 1
    `).get(conversationId, assetId, conversationId, assetId) as Row | undefined;
    return Boolean(row);
  }

  getFileAssetRecord(id: string): FileAssetRecord | undefined {
    const row = this.sqlite.prepare(`
      SELECT a.*, b.byte_size, b.storage_key FROM file_assets a
      JOIN file_blobs b ON b.sha256 = a.sha256 WHERE a.id = ?
    `).get(id) as Row | undefined;
    return row ? fileAssetRecord(row) : undefined;
  }

  getImageAssetRecord(id: string): ImageAssetRecord | undefined {
    const record = this.getFileAssetRecord(id);
    return record?.kind === "image" ? record as ImageAssetRecord : undefined;
  }

  findImageAssetBySha256(sha256: string): ImageAssetRecord | undefined {
    const row = this.sqlite.prepare(`
      SELECT a.*, b.byte_size, b.storage_key FROM file_assets a JOIN file_blobs b ON b.sha256 = a.sha256
      WHERE a.sha256 = ? AND a.kind = 'image' ORDER BY a.created_at LIMIT 1
    `).get(sha256) as Row | undefined;
    return row ? fileAssetRecord(row) as ImageAssetRecord : undefined;
  }

  messageFiles(messageId: string): FileAssetDto[] {
    return (this.sqlite.prepare(`
      SELECT a.*, b.byte_size FROM file_assets a JOIN file_blobs b ON b.sha256 = a.sha256
      JOIN message_file_assets m ON m.asset_id = a.id
      WHERE m.message_id = ? ORDER BY m.asset_index
    `).all(messageId) as Row[]).map(fileAssetDto);
  }

  messageImages(messageId: string): ImageAssetDto[] {
    return this.messageFiles(messageId).filter((asset): asset is ImageAssetDto => asset.kind === "image");
  }

  toolCallFiles(toolCallId: string): FileAssetDto[] {
    return (this.sqlite.prepare(`
      SELECT a.*, b.byte_size FROM file_assets a JOIN file_blobs b ON b.sha256 = a.sha256
      JOIN tool_call_file_assets t ON t.asset_id = a.id
      WHERE t.tool_call_id = ? ORDER BY t.asset_index
    `).all(toolCallId) as Row[]).map(fileAssetDto);
  }

  toolCallImages(toolCallId: string): ImageAssetDto[] {
    return this.toolCallFiles(toolCallId).filter((asset): asset is ImageAssetDto => asset.kind === "image");
  }

  attachFilesToMessage(messageId: string, assetIds: string[], imageBytesLimit = 15 * 1024 * 1024): void {
    this.validateAttachments(assetIds, imageBytesLimit);
    const insert = this.sqlite.prepare("INSERT INTO message_file_assets (message_id, asset_id, asset_index) VALUES (?, ?, ?)");
    assetIds.forEach((assetId, index) => insert.run(messageId, assetId, index));
  }

  validateAttachments(assetIds: string[], imageBytesLimit = 15 * 1024 * 1024): void {
    const unique = [...new Set(assetIds)];
    if (unique.length !== assetIds.length || unique.length > 8) {
      throw new StoreError("file_attachment_invalid", "每条消息最多包含 8 个不重复附件");
    }
    const assets = unique.map((id) => this.getFileAsset(id));
    if (assets.some((asset) => !asset)) throw new StoreError("file_asset_not_found", "文件资产不存在");
    const total = assets.reduce((sum, asset) => sum + (asset?.byteSize ?? 0), 0);
    if (total > 128 * 1024 * 1024) throw new StoreError("file_attachments_too_large", "每条消息的附件总大小不能超过 128 MiB");
    const images = assets.filter((asset): asset is ImageAssetDto => asset?.kind === "image");
    if (images.length > 4) throw new StoreError("image_attachment_invalid", "每条消息最多包含 4 张图片");
    if (images.reduce((sum, asset) => sum + asset.byteSize, 0) > imageBytesLimit) {
      throw new StoreError("image_attachments_too_large", "每条消息的图片总大小不能超过 15 MiB");
    }
  }

  attachImagesToMessage(messageId: string, assetIds: string[]): void {
    this.attachFilesToMessage(messageId, assetIds);
  }

  attachFileToToolCall(toolCallId: string, assetId: string): void {
    if (!this.getFileAsset(assetId)) throw new StoreError("file_asset_not_found", "文件资产不存在");
    const next = this.sqlite.prepare(`
      SELECT COALESCE(MAX(asset_index), -1) + 1 AS value FROM tool_call_file_assets WHERE tool_call_id = ?
    `).get(toolCallId) as Row;
    this.sqlite.prepare(`
      INSERT OR IGNORE INTO tool_call_file_assets (tool_call_id, asset_id, asset_index) VALUES (?, ?, ?)
    `).run(toolCallId, assetId, Number(next.value));
  }

  attachImageToToolCall(toolCallId: string, assetId: string): void {
    this.attachFileToToolCall(toolCallId, assetId);
  }

  createImageAssistantMessage(conversationId: string): string {
    return this.transaction(() => this.insertImageAssistantMessage(conversationId));
  }

  private insertImageAssistantMessage(conversationId: string): string {
    if (!this.getConversation(conversationId)) throw new StoreError("conversation_not_found", "会话不存在");
    const row = this.sqlite.prepare("SELECT COALESCE(MAX(ordinal), 0) AS value FROM messages WHERE conversation_id = ?")
      .get(conversationId) as Row;
    const id = randomUUID();
    this.sqlite.prepare(`INSERT INTO messages (id, conversation_id, ordinal, role, text, active_generation_id, created_at)
      VALUES (?, ?, ?, 'assistant', NULL, NULL, ?)`).run(id, conversationId, Number(row.value) + 1, Date.now());
    return id;
  }

  createImageGenerationJob(input: {
    conversationId: string;
    assistantMessageId?: string;
    toolCallId?: string;
    model: ModelDto;
    connection: ConnectionRecord;
    request: ImageGenerationInput;
  }): ImageGenerationJobDto {
    return this.transaction(() => {
      const assistantMessageId = input.assistantMessageId ?? this.insertImageAssistantMessage(input.conversationId);
      const protocol = input.model.imageProtocol;
      if (!protocol) throw new StoreError("image_protocol_required", "图片模型缺少图片协议");
      const now = Date.now();
      const id = randomUUID();
      this.sqlite.prepare(`
        INSERT INTO image_generation_jobs (
          id, conversation_id, assistant_message_id, tool_call_id, model_id, connection_id,
          model_key, connection_name, image_protocol, operation, prompt, request_json, status,
          progress, provider_job_id, output_asset_ids_json, revised_prompt, error_code, error_message,
          created_at, started_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', NULL, NULL, '[]', NULL, NULL, NULL, ?, NULL, NULL)
      `).run(
        id, input.conversationId, assistantMessageId, input.toolCallId ?? null, input.model.id,
        input.connection.id, input.model.modelKey, input.connection.name, protocol, input.request.operation,
        input.request.prompt, json(input.request), now
      );
      return this.getImageGenerationJob(id)!;
    });
  }

  getImageGenerationInput(id: string): ImageGenerationInput | undefined {
    const row = this.sqlite.prepare("SELECT request_json FROM image_generation_jobs WHERE id = ?").get(id) as Row | undefined;
    if (!row) return undefined;
    const parsed = imageGenerationInputSchema.safeParse(parse(row.request_json, {}));
    return parsed.success ? parsed.data : undefined;
  }

  getImageGenerationJob(id: string): ImageGenerationJobDto | undefined {
    const row = this.sqlite.prepare("SELECT * FROM image_generation_jobs WHERE id = ?").get(id) as Row | undefined;
    return row ? imageGenerationJobDto(row, this) : undefined;
  }

  listImageGenerationJobs(conversationId?: string): ImageGenerationJobDto[] {
    const rows = conversationId
      ? this.sqlite.prepare("SELECT * FROM image_generation_jobs WHERE conversation_id = ? ORDER BY created_at DESC").all(conversationId)
      : this.sqlite.prepare("SELECT * FROM image_generation_jobs ORDER BY created_at DESC").all();
    return (rows as Row[]).map((row) => imageGenerationJobDto(row, this));
  }

  updateImageGenerationJob(id: string, patch: {
    status?: ImageGenerationJobStatus;
    progress?: number | null;
    providerJobId?: string | null;
    outputAssetIds?: string[];
    revisedPrompt?: string | null;
    error?: { code: string; message: string } | null;
    startedAt?: number | null;
    completedAt?: number | null;
  }): ImageGenerationJobDto | undefined {
    const current = this.getImageGenerationJob(id);
    if (!current) return undefined;
    const status = patch.status ?? current.status;
    const error = patch.error === undefined ? current.error : patch.error;
    this.sqlite.prepare(`
      UPDATE image_generation_jobs SET status = ?, progress = ?, provider_job_id = ?, output_asset_ids_json = ?,
        revised_prompt = ?, error_code = ?, error_message = ?, started_at = ?, completed_at = ? WHERE id = ?
    `).run(
      status,
      patch.progress === undefined ? current.progress : patch.progress,
      patch.providerJobId === undefined ? current.providerJobId : patch.providerJobId,
      JSON.stringify(patch.outputAssetIds ?? current.outputAssets.map((asset) => asset.id)),
      patch.revisedPrompt === undefined ? current.revisedPrompt : patch.revisedPrompt,
      error?.code ?? null,
      error?.message ?? null,
      patch.startedAt === undefined ? current.startedAt : patch.startedAt,
      patch.completedAt === undefined ? current.completedAt : patch.completedAt,
      id
    );
    return this.getImageGenerationJob(id);
  }

  attachImageJobOutputs(id: string, assetIds: string[]): ImageGenerationJobDto | undefined {
    const job = this.getImageGenerationJob(id);
    if (!job) return undefined;
    this.attachFilesToMessage(job.assistantMessageId, assetIds, 128 * 1024 * 1024);
    return this.updateImageGenerationJob(id, { outputAssetIds: assetIds });
  }

  unreferencedFileAssets(before: number): FileAssetRecord[] {
    return (this.sqlite.prepare(`
      SELECT a.*, b.byte_size, b.storage_key FROM file_assets a JOIN file_blobs b ON b.sha256 = a.sha256
      WHERE a.created_at < ?
        AND NOT EXISTS (SELECT 1 FROM message_file_assets m WHERE m.asset_id = a.id)
        AND NOT EXISTS (SELECT 1 FROM tool_call_file_assets t WHERE t.asset_id = a.id)
        AND NOT EXISTS (SELECT 1 FROM agent_file_assets r WHERE r.asset_id = a.id)
        AND NOT EXISTS (SELECT 1 FROM vision_analyses v WHERE v.asset_id = a.id)
        AND NOT EXISTS (SELECT 1 FROM queued_message_assets q WHERE q.asset_id = a.id)
    `).all(before) as Row[]).map(fileAssetRecord);
  }

  unreferencedImageAssets(before: number): ImageAssetRecord[] {
    return this.unreferencedFileAssets(before).filter((asset): asset is ImageAssetRecord => asset.kind === "image");
  }

  deleteFileAsset(id: string): { deleted: boolean; storageKey: string | null } {
    const asset = this.getFileAssetRecord(id);
    if (!asset) return { deleted: false, storageKey: null };
    const deleted = Number(this.sqlite.prepare("DELETE FROM file_assets WHERE id = ?").run(id).changes) > 0;
    const remaining = this.sqlite.prepare("SELECT 1 FROM file_assets WHERE sha256 = ? LIMIT 1").get(asset.sha256);
    if (remaining) return { deleted, storageKey: null };
    this.sqlite.prepare("DELETE FROM file_blobs WHERE sha256 = ?").run(asset.sha256);
    return { deleted, storageKey: asset.storageKey };
  }

  deleteImageAsset(id: string): boolean {
    return this.deleteFileAsset(id).deleted;
  }

  getVisionAnalysisByCacheKey(cacheKey: string): VisionAnalysisDto | undefined {
    const row = this.sqlite.prepare("SELECT * FROM vision_analyses WHERE cache_key = ?").get(cacheKey) as Row | undefined;
    return row ? this.visionAnalysisDto(row, true) : undefined;
  }

  beginVisionAnalysis(input: { cacheKey: string; assetId: string; model: GeneratedModelDto }): VisionAnalysisDto {
    const now = Date.now();
    const id = randomUUID();
    this.sqlite.prepare(`
      INSERT INTO vision_analyses (id, asset_id, cache_key, status, model_id, model_display_name,
        model_key, connection_name, protocol, description, usage_json, error, created_at, completed_at)
      VALUES (?, ?, ?, 'running', ?, ?, ?, ?, ?, NULL, '{}', NULL, ?, NULL)
      ON CONFLICT(cache_key) DO UPDATE SET status = 'running', model_id = excluded.model_id,
        model_display_name = excluded.model_display_name, model_key = excluded.model_key,
        connection_name = excluded.connection_name, protocol = excluded.protocol,
        description = NULL, usage_json = '{}', error = NULL, created_at = excluded.created_at, completed_at = NULL
    `).run(id, input.assetId, input.cacheKey, input.model.modelId, input.model.displayName,
      input.model.modelKey, input.model.connectionName, input.model.protocol, now);
    const row = this.sqlite.prepare("SELECT * FROM vision_analyses WHERE cache_key = ?").get(input.cacheKey) as Row;
    return this.visionAnalysisDto(row, false);
  }

  finishVisionAnalysis(id: string, description: string, usage: UsageDto): VisionAnalysisDto {
    this.sqlite.prepare(`
      UPDATE vision_analyses SET status = 'completed', description = ?, usage_json = ?, error = NULL,
        completed_at = ? WHERE id = ?
    `).run(description, json(usage), Date.now(), id);
    return this.getVisionAnalysis(id)!;
  }

  failVisionAnalysis(id: string, error: string): VisionAnalysisDto {
    this.sqlite.prepare(`
      UPDATE vision_analyses SET status = 'failed', error = ?, completed_at = ? WHERE id = ?
    `).run(error, Date.now(), id);
    return this.getVisionAnalysis(id)!;
  }

  getVisionAnalysis(id: string): VisionAnalysisDto | undefined {
    const row = this.sqlite.prepare("SELECT * FROM vision_analyses WHERE id = ?").get(id) as Row | undefined;
    return row ? this.visionAnalysisDto(row, false) : undefined;
  }

  linkVisionAnalysis(generationId: string, analysisId: string, cached: boolean): VisionAnalysisDto {
    const existing = this.sqlite.prepare(`
      SELECT analysis_index FROM generation_vision_analyses WHERE generation_id = ? AND analysis_id = ?
    `).get(generationId, analysisId) as Row | undefined;
    if (!existing) {
      const next = this.sqlite.prepare(`
        SELECT COALESCE(MAX(analysis_index), -1) + 1 AS value
        FROM generation_vision_analyses WHERE generation_id = ?
      `).get(generationId) as Row;
      this.sqlite.prepare(`
        INSERT INTO generation_vision_analyses (generation_id, analysis_id, analysis_index, cached)
        VALUES (?, ?, ?, ?)
      `).run(generationId, analysisId, Number(next.value), cached ? 1 : 0);
    }
    const row = this.sqlite.prepare("SELECT * FROM vision_analyses WHERE id = ?").get(analysisId) as Row;
    return this.visionAnalysisDto(row, cached);
  }

  generationVisionAnalyses(generationId: string): VisionAnalysisDto[] {
    return (this.sqlite.prepare(`
      SELECT v.*, g.cached AS generation_cached FROM vision_analyses v
      JOIN generation_vision_analyses g ON g.analysis_id = v.id
      WHERE g.generation_id = ? ORDER BY g.analysis_index
    `).all(generationId) as Row[]).map((row) => this.visionAnalysisDto(row, Boolean(row.generation_cached)));
  }

  listConversations(): ConversationDto[] {
    const conversations = (this.sqlite.prepare(`
      SELECT c.*, a.execution_json AS agent_execution_json
      FROM conversations c LEFT JOIN agents a ON a.id = c.agent_id
      ORDER BY c.updated_at DESC
    `).all() as Row[]).map(conversationDto);
    const activeByRoot = new Map<string, string>();
    for (const conversation of conversations) {
      const root = this.rootConversationId(conversation.id);
      if (root && !activeByRoot.has(root)) activeByRoot.set(root, this.activeBranchIdForRoot(root));
    }
    return conversations.map((conversation) => ({
      ...conversation,
      activeBranchId: activeByRoot.get(this.rootConversationId(conversation.id) ?? conversation.id) ?? conversation.id
    }));
  }

  getConversation(id: string): ConversationDto | undefined {
    const row = this.sqlite.prepare(`
      SELECT c.*, a.execution_json AS agent_execution_json
      FROM conversations c LEFT JOIN agents a ON a.id = c.agent_id WHERE c.id = ?
    `).get(id) as Row | undefined;
    if (!row) return undefined;
    const conversation = conversationDto(row);
    return { ...conversation, activeBranchId: this.activeBranchIdFor(conversation.id) };
  }

  createConversation(input: {
    title?: string | undefined;
    agentId: string;
    executionOverrides?: ConversationExecutionOverrides | undefined;
    workspacePath?: string | null | undefined;
  } | {
    title?: string | undefined;
    systemPrompt: string;
    contextPolicy?: ContextPolicy | undefined;
  }): ConversationDto {
    const now = Date.now();
    const id = randomUUID();
    const agentId = "agentId" in input ? input.agentId : this.getSettings().defaultAgentId;
    const agent = this.getAgent(agentId);
    if (!agent) throw new StoreError("agent_not_found", "Agent 不存在");
    const overrides = conversationExecutionOverridesSchema.parse("agentId" in input
      ? this.newConversationOverrides(agentId, input.executionOverrides)
      : this.newConversationOverrides(agentId, { contextPolicy: input.contextPolicy }));
    const modelId = effectiveModelId(agent.execution, overrides);
    if (modelId) this.validateAgentModel(modelId);
    const contextPolicy = overrides.contextPolicy ?? agent.execution.contextPolicy;
    this.sqlite.prepare(`
      INSERT INTO conversations (id, title, system_prompt, context_policy, model_id, draft, reasoning_effort,
        agent_id, execution_overrides_json, workspace_path, created_at, updated_at)
      VALUES (?, ?, '', ?, ?, '', NULL, ?, ?, ?, ?, ?)
    `).run(id, input.title ?? "新对话", contextPolicy, modelId, agent.id, json(overrides),
      "workspacePath" in input ? input.workspacePath ?? null : null, now, now);
    this.sqlite.prepare(`
      INSERT OR IGNORE INTO conversation_family_state (root_conversation_id, active_conversation_id, updated_at)
      VALUES (?, ?, ?)
    `).run(id, id, now);
    this.sqlite.prepare("UPDATE app_settings SET last_agent_id = ? WHERE id = 1").run(agent.id);
    if ("workspacePath" in input && input.workspacePath) {
      this.sqlite.prepare("UPDATE app_settings SET last_workspace_path = ? WHERE id = 1").run(input.workspacePath);
    }
    return this.getConversation(id)!;
  }

  startConversation(input: {
    text: string;
    assetIds?: string[] | undefined;
    imageAssetIds?: string[] | undefined;
    agentId: string;
    greetingIndex: number;
    executionOverrides?: ConversationExecutionOverrides | undefined;
    workspacePath?: string | null | undefined;
  } | {
    text: string;
    assetIds?: string[] | undefined;
    imageAssetIds?: string[] | undefined;
    modelId: string;
    contextPolicy?: ContextPolicy | undefined;
  }): ConversationStartedDto {
    return this.transaction(() => {
      const now = Date.now();
      const conversation = this.createConversation({
        agentId: "agentId" in input ? input.agentId : this.getSettings().defaultAgentId,
        executionOverrides: "agentId" in input
          ? input.executionOverrides
          : {
              modelId: input.modelId,
              contextPolicy: input.contextPolicy
            },
        workspacePath: "workspacePath" in input ? input.workspacePath : null
      });
      const agent = this.getAgent(conversation.agentId!)!;
      const rawGreetings = [agent.card.data.first_mes, ...agent.card.data.alternate_greetings];
      const selectedSourceIndex = "greetingIndex" in input ? input.greetingIndex : 0;
      const greeting = rawGreetings[selectedSourceIndex];
      if (greeting === undefined) throw new StoreError("greeting_not_found", "所选开场白不存在");
      if ("agentId" in input && greeting.trim()) {
        const userName = this.resolvedUserProfile(agent).displayName;
        const candidates = rawGreetings
          .map((text, sourceIndex) => ({ sourceIndex, text: substituteCardPlaceholders(text, agent.name, userName) }))
          .filter((item) => item.text.trim().length > 0);
        const activeIndex = candidates.findIndex((item) => item.sourceIndex === selectedSourceIndex);
        const greetingSnapshot = greetingMessageSchema.parse({
          variants: candidates.map((item) => item.text),
          activeIndex,
          agent: { agentId: agent.id, name: agent.name, revision: agent.revision }
        });
        this.sqlite.prepare(`
          INSERT INTO messages (id, conversation_id, ordinal, role, text, active_generation_id, created_at, greeting_json)
          VALUES (?, ?, 1, 'assistant', ?, NULL, ?, ?)
        `).run(randomUUID(), conversation.id, greetingSnapshot.variants[activeIndex]!, now, json(greetingSnapshot));
      }
      const generation = this.insertMessageGeneration(
        conversation,
        input.text,
        this.resolveGeneration(conversation).snapshot,
        input.assetIds ?? input.imageAssetIds ?? []
      );
      return {
        conversation: this.getConversation(conversation.id)!,
        generation
      };
    });
  }

  updateConversation(id: string, patch: OptionalInput<Pick<ConversationDto,
    "title" | "agentId" | "executionOverrides" | "draft" | "modelId" | "contextPolicy" | "systemPrompt" | "workspacePath"
  >>): ConversationDto | undefined {
    return this.transaction(() => {
      const current = this.getConversation(id);
      if (!current) return undefined;
      const switchingAgent = patch.agentId !== undefined && patch.agentId !== current.agentId;
      const agentId = patch.agentId === undefined ? current.agentId : patch.agentId;
      const agent = agentId ? this.getAgent(agentId) : undefined;
      if (agentId && !agent) throw new StoreError("agent_not_found", "Agent 不存在");
      const legacyOverrides: ConversationExecutionOverrides = {
        ...current.executionOverrides,
        ...(patch.modelId !== undefined ? { modelId: patch.modelId } : {}),
        ...(patch.contextPolicy !== undefined ? { contextPolicy: patch.contextPolicy } : {})
      };
      if (patch.modelId !== undefined && patch.modelId !== null) this.validateAgentModel(patch.modelId);
      const executionOverrides = switchingAgent
        ? conversationExecutionOverridesSchema.parse({})
        : conversationExecutionOverridesSchema.parse(patch.executionOverrides ?? legacyOverrides);
      const modelId = agent ? effectiveModelId(agent.execution, executionOverrides) : null;
      const selectedModel = !switchingAgent && modelId && (patch.modelId !== undefined ||
        (patch.executionOverrides?.modelId !== undefined && patch.executionOverrides.modelId !== current.executionOverrides.modelId));
      if (selectedModel && agentId) this.rememberAgentModel(agentId, modelId);
      const contextPolicy = executionOverrides.contextPolicy ?? agent?.execution.contextPolicy ?? current.contextPolicy;
      const next = {
        title: patch.title ?? current.title,
        agentId,
        executionOverrides,
        contextPolicy,
        modelId,
        draft: patch.draft ?? current.draft,
        workspacePath: patch.workspacePath === undefined ? current.workspacePath : patch.workspacePath
      };
      this.sqlite.prepare(`
        UPDATE conversations SET title = ?, system_prompt = ?, agent_id = ?, execution_overrides_json = ?, context_policy = ?, model_id = ?,
          draft = ?, workspace_path = ?, updated_at = ? WHERE id = ?
      `).run(next.title, patch.systemPrompt ?? current.systemPrompt, next.agentId, json(next.executionOverrides), next.contextPolicy,
        next.modelId, next.draft, next.workspacePath, Date.now(), id);
      if (switchingAgent || patch.executionOverrides !== undefined || patch.modelId !== undefined) {
        this.sqlite.prepare("DELETE FROM context_summaries WHERE conversation_id = ?").run(id);
      }
      if (switchingAgent && next.agentId) this.sqlite.prepare("UPDATE app_settings SET last_agent_id = ? WHERE id = 1").run(next.agentId);
      return this.getConversation(id);
    });
  }

  conversationDeletionIds(id: string): string[] {
    const descendants = this.sqlite.prepare(`
      WITH RECURSIVE subtree(id, depth) AS (
        SELECT id, 0 FROM conversations WHERE id = ?
        UNION ALL
        SELECT child.id, subtree.depth + 1
        FROM conversations child JOIN subtree ON child.parent_conversation_id = subtree.id
      )
      SELECT id FROM subtree ORDER BY depth DESC
    `).all(id) as Row[];
    return descendants.map((row) => String(row.id));
  }


  conversationCacheRevision(id: string): number {
    const row = this.sqlite.prepare("SELECT cache_revision AS revision FROM conversations WHERE id = ?").get(id) as Row | undefined;
    if (!row) throw new StoreError("conversation_not_found", "会话不存在");
    return Number(row.revision);
  }

  conversationHasFileAsset(conversationId: string, assetId: string): boolean {
    return Boolean(this.sqlite.prepare(`
      SELECT 1 FROM message_file_assets f JOIN messages m ON m.id = f.message_id
      WHERE f.asset_id = ? AND m.conversation_id = ? LIMIT 1
    `).get(assetId, conversationId));
  }

  deleteConversation(id: string): boolean {
    return this.transaction(() => {
      const root = this.rootConversationId(id);
      const selected = root
        ? this.sqlite.prepare("SELECT active_conversation_id FROM conversation_family_state WHERE root_conversation_id = ?").get(root) as Row | undefined
        : undefined;
      const descendants = this.conversationDeletionIds(id);
      for (const conversationId of descendants) {
        this.sqlite.prepare("DELETE FROM conversations WHERE id = ?").run(conversationId);
      }
      if (root && this.rootConversationId(root)) {
        const candidate = selected?.active_conversation_id ? String(selected.active_conversation_id) : root;
        const active = this.rootConversationId(candidate) === root ? candidate : root;
        this.setFamilyActiveBranch(root, active);
      }
      return descendants.length > 0;
    });
  }

  forkConversation(sourceConversationId: string, input: ForkConversationInput): ConversationForkDto {
    return this.transaction(() => {
      const source = this.getConversation(sourceConversationId);
      if (!source) throw new StoreError("conversation_not_found", "会话不存在");
      if (!source.agentId) throw new StoreError("conversation_agent_required", "原会话的 Agent 已不可用");

      if (input.mode === "greeting") {
        const message = this.sqlite.prepare(
          "SELECT id, ordinal, role, greeting_json FROM messages WHERE id = ? AND conversation_id = ? AND history_active = 1"
        ).get(input.messageId, sourceConversationId) as Row | undefined;
        const parsed = message?.greeting_json
          ? greetingMessageSchema.safeParse(parse(message.greeting_json, null))
          : null;
        if (!message || message.role !== "assistant" || Number(message.ordinal) !== 1 || !parsed?.success) {
          throw new StoreError("greeting_not_found", "要切换的开场白不存在");
        }
        const text = parsed.data.variants[input.greetingIndex];
        if (text === undefined) throw new StoreError("greeting_not_found", "所选开场白不存在");
        if (input.greetingIndex === parsed.data.activeIndex) {
          throw new StoreError("greeting_unchanged", "所选开场白已经生效");
        }
        if (this.isConversationBusy(sourceConversationId)) {
          throw new StoreError("conversation_busy", "会话仍有生成或工具审批未完成");
        }
        const fork = this.createConversation({
          title: this.rootConversationTitle(source.id),
          agentId: source.agentId,
          executionOverrides: source.executionOverrides,
          workspacePath: source.workspacePath
        });
        this.cloneRoleplayStates(source.id, fork.id);
        this.sqlite.prepare(`
          UPDATE conversations SET system_prompt = ?, parent_conversation_id = ?, forked_from_message_id = ?,
            fork_mode = 'greeting', fork_point_ordinal = ?, fork_greeting_index = ?, fork_source_greeting_index = ?
          WHERE id = ?
        `).run(
          source.systemPrompt,
          source.id,
          String(message.id),
          Number(message.ordinal),
          input.greetingIndex,
          parsed.data.activeIndex,
          fork.id
        );
        const greeting = { ...parsed.data, activeIndex: input.greetingIndex };
        this.sqlite.prepare(`
          INSERT INTO messages (id, conversation_id, ordinal, role, text, active_generation_id, created_at, greeting_json)
          VALUES (?, ?, 1, 'assistant', ?, NULL, ?, ?)
        `).run(randomUUID(), fork.id, text, Date.now(), json(greeting));
        this.activateConversationBranch(fork.id);
        return { conversation: this.getConversation(fork.id)!, generation: null };
      }

      let throughOrdinal = 0;
      let sourceMessageId: string | null = null;
      let sourceMessageOrdinal: number | null = null;
      if (input.mode === "edit") {
        const message = this.sqlite.prepare(
          "SELECT id, ordinal, role FROM messages WHERE id = ? AND conversation_id = ? AND history_active = 1"
        ).get(input.messageId, sourceConversationId) as Row | undefined;
        if (!message || message.role !== "user") {
          throw new StoreError("message_not_found", "要编辑的用户消息不存在");
        }
        throughOrdinal = Number(message.ordinal) - 1;
        sourceMessageId = String(message.id);
        sourceMessageOrdinal = Number(message.ordinal);
      } else if (input.throughMessageId) {
        const message = this.sqlite.prepare(
          "SELECT id, ordinal, role FROM messages WHERE id = ? AND conversation_id = ? AND history_active = 1"
        ).get(input.throughMessageId, sourceConversationId) as Row | undefined;
        if (!message || message.role !== "assistant") {
          throw new StoreError("message_not_found", "分叉检查点不存在");
        }
        throughOrdinal = Number(message.ordinal);
        sourceMessageId = String(message.id);
        sourceMessageOrdinal = Number(message.ordinal);
      }

      const active = this.sqlite.prepare(`
        SELECT 1 FROM messages m JOIN generations g ON g.id = m.active_generation_id
        WHERE m.conversation_id = ? AND m.ordinal <= ?
          AND g.status IN ('queued', 'running', 'waiting-approval') LIMIT 1
      `).get(sourceConversationId, throughOrdinal);
      if (active) throw new StoreError("conversation_busy", "分叉范围内仍有生成或工具审批未完成");

      const fork = this.createConversation({
        title: this.rootConversationTitle(source.id),
        agentId: source.agentId,
        executionOverrides: source.executionOverrides,
        workspacePath: source.workspacePath
      });
      this.cloneRoleplayStates(source.id, fork.id);
      this.sqlite.prepare(`
        UPDATE conversations SET system_prompt = ?, parent_conversation_id = ?, forked_from_message_id = ?,
          fork_mode = ?, fork_point_ordinal = ?
        WHERE id = ?
      `).run(source.systemPrompt, source.id, sourceMessageId, input.mode, sourceMessageOrdinal, fork.id);
      this.cloneVisibleHistory(source.id, fork.id, throughOrdinal);

      let generation: GenerationCreatedDto | null = null;
      if (input.mode === "edit") {
        const forkConversation = this.getConversation(fork.id)!;
        generation = this.insertMessageGeneration(
          forkConversation,
          input.text ?? "",
          this.resolveGeneration(forkConversation).snapshot,
          input.assetIds ?? input.imageAssetIds
        );
      }
      this.activateConversationBranch(fork.id);
      return { conversation: this.getConversation(fork.id)!, generation };
    });
  }

  selectConversationBranch(sourceConversationId: string, branchId: string): { activeBranchId: string } {
    return this.transaction(() => {
      const root = this.rootConversationId(sourceConversationId);
      const branchRoot = this.rootConversationId(branchId);
      if (!root || !branchRoot) throw new StoreError("conversation_not_found", "会话不存在");
      if (root !== branchRoot) throw new StoreError("conversation_branch_invalid", "所选分支不属于当前会话");
      this.setFamilyActiveBranch(root, branchId);
      return { activeBranchId: branchId };
    });
  }

  private rootConversationId(id: string): string | undefined {
    const row = this.sqlite.prepare(`
      WITH RECURSIVE lineage(id, parent_id, depth) AS (
        SELECT id, parent_conversation_id, 0 FROM conversations WHERE id = ?
        UNION ALL
        SELECT parent.id, parent.parent_conversation_id, lineage.depth + 1
        FROM conversations parent JOIN lineage ON parent.id = lineage.parent_id
        WHERE lineage.depth < 100
      )
      SELECT id FROM lineage ORDER BY depth DESC LIMIT 1
    `).get(id) as Row | undefined;
    return row ? String(row.id) : undefined;
  }

  private activeBranchIdFor(id: string): string {
    const root = this.rootConversationId(id) ?? id;
    return this.activeBranchIdForRoot(root);
  }

  private activeBranchIdForRoot(root: string): string {
    const row = this.sqlite.prepare(
      "SELECT active_conversation_id FROM conversation_family_state WHERE root_conversation_id = ?"
    ).get(root) as Row | undefined;
    const active = row?.active_conversation_id ? String(row.active_conversation_id) : root;
    return this.rootConversationId(active) === root ? active : root;
  }

  private setFamilyActiveBranch(root: string, active: string): void {
    this.sqlite.prepare(`
      INSERT INTO conversation_family_state (root_conversation_id, active_conversation_id, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(root_conversation_id) DO UPDATE SET active_conversation_id = excluded.active_conversation_id,
        updated_at = excluded.updated_at
    `).run(root, active, Date.now());
  }

  private activateConversationBranch(id: string): void {
    const root = this.rootConversationId(id);
    if (!root) throw new StoreError("conversation_not_found", "会话不存在");
    if (root !== id) {
      this.sqlite.prepare("DELETE FROM conversation_family_state WHERE root_conversation_id = ?").run(id);
    }
    this.setFamilyActiveBranch(root, id);
  }

  private rootConversationTitle(conversationId: string): string {
    const row = this.sqlite.prepare(`
      WITH RECURSIVE lineage(id, title, parent_id, depth) AS (
        SELECT id, title, parent_conversation_id, 0 FROM conversations WHERE id = ?
        UNION ALL
        SELECT parent.id, parent.title, parent.parent_conversation_id, lineage.depth + 1
        FROM conversations parent JOIN lineage ON parent.id = lineage.parent_id
        WHERE lineage.depth < 100
      )
      SELECT title FROM lineage ORDER BY depth DESC LIMIT 1
    `).get(conversationId) as Row | undefined;
    return row ? String(row.title) : "新对话";
  }

  private cloneVisibleHistory(sourceConversationId: string, targetConversationId: string, throughOrdinal: number): void {
    if (throughOrdinal <= 0) return;
    const messages = this.sqlite.prepare(`
      SELECT * FROM messages WHERE conversation_id = ? AND history_active = 1 AND ordinal <= ? ORDER BY ordinal
    `).all(sourceConversationId, throughOrdinal) as Row[];
    for (const message of messages) {
      if (this.sqlite.prepare(`SELECT 1 FROM image_generation_jobs j JOIN generation_tool_calls tc ON tc.id = j.tool_call_id
        WHERE j.assistant_message_id = ?`).get(String(message.id))) continue;
      const messageId = randomUUID();
      this.sqlite.prepare(`
        INSERT INTO messages (id, conversation_id, ordinal, role, text, active_generation_id, created_at, greeting_json)
        VALUES (?, ?, ?, ?, ?, NULL, ?, ?)
      `).run(messageId, targetConversationId, Number(message.ordinal), String(message.role),
        message.text === null ? null : String(message.text),
        Number(message.created_at), message.greeting_json === null || message.greeting_json === undefined
          ? null
          : String(message.greeting_json));
      for (const [index, asset] of this.messageFiles(String(message.id)).entries()) {
        this.sqlite.prepare(`
          INSERT INTO message_file_assets (message_id, asset_id, asset_index) VALUES (?, ?, ?)
        `).run(messageId, asset.id, index);
      }
      let activeGenerationId: string | null = null;
      if (message.role === "assistant" && message.active_generation_id) {
        const generation = this.sqlite.prepare("SELECT * FROM generations WHERE id = ?")
          .get(String(message.active_generation_id)) as Row | undefined;
        if (!generation) throw new StoreError("generation_not_found", "分叉历史中的生成不存在");
        activeGenerationId = randomUUID();
        this.insertClonedRow("generations", generation, {
          id: activeGenerationId,
          assistant_message_id: messageId,
          version: 1
        });
        for (const block of this.sqlite.prepare("SELECT * FROM generation_blocks WHERE generation_id = ? ORDER BY block_index")
          .all(String(generation.id)) as Row[]) {
          this.insertClonedRow("generation_blocks", block, { id: randomUUID(), generation_id: activeGenerationId });
        }
        for (const call of this.sqlite.prepare("SELECT * FROM generation_tool_calls WHERE generation_id = ? ORDER BY call_index")
          .all(String(generation.id)) as Row[]) {
          const clonedCallId = randomUUID();
          this.insertClonedRow("generation_tool_calls", call, {
            id: clonedCallId,
            generation_id: activeGenerationId,
            provider_id: call.provider_id ?? call.id
          });
          for (const [index, asset] of this.toolCallFiles(String(call.id)).entries()) {
            this.sqlite.prepare(`
              INSERT INTO tool_call_file_assets (tool_call_id, asset_id, asset_index) VALUES (?, ?, ?)
            `).run(clonedCallId, asset.id, index);
          }
        }
        for (const step of this.sqlite.prepare("SELECT * FROM generation_steps WHERE generation_id = ? ORDER BY step_index")
          .all(String(generation.id)) as Row[]) {
          this.insertClonedRow("generation_steps", step, { generation_id: activeGenerationId });
        }
        for (const analysis of this.sqlite.prepare(`
          SELECT analysis_id, analysis_index, cached
          FROM generation_vision_analyses WHERE generation_id = ? ORDER BY analysis_index
        `).all(String(generation.id)) as Row[]) {
          this.sqlite.prepare(`
            INSERT INTO generation_vision_analyses (generation_id, analysis_id, analysis_index, cached)
            VALUES (?, ?, ?, ?)
          `).run(activeGenerationId, String(analysis.analysis_id), Number(analysis.analysis_index), Number(analysis.cached));
        }
      }
      if (activeGenerationId) {
        this.sqlite.prepare("UPDATE messages SET active_generation_id = ? WHERE id = ?").run(activeGenerationId, messageId);
      }
    }
  }

  private insertClonedRow(
    table: "generations" | "generation_blocks" | "generation_tool_calls" | "generation_steps",
    source: Row,
    replacements: Row
  ): void {
    const row = { ...source, ...replacements };
    const columns = Object.keys(row);
    const quoted = columns.map((column) => `"${column.replaceAll('"', '""')}"`);
    const placeholders = columns.map(() => "?");
    this.sqlite.prepare(`INSERT INTO ${table} (${quoted.join(", ")}) VALUES (${placeholders.join(", ")})`)
      .run(...columns.map((column) => row[column] as never));
  }

  private resolvedUserProfile(agent: AgentDto): { displayName: string; description: string } {
    const global = this.getSettings().userProfile;
    return {
      displayName: agent.userProfile.displayName ?? global.displayName,
      description: agent.userProfile.description ?? global.description
    };
  }

  resolveGeneration(conversation: ConversationDto, generationKind: RoleplayGenerationTrigger = "normal") {
    const agent = conversation.agentId ? this.getAgent(conversation.agentId) : undefined;
    const modelId = agent ? effectiveModelId(agent.execution, conversation.executionOverrides) : null;
    const model = modelId ? this.getModel(modelId) : undefined;
    return resolveGenerationPlan({
      conversation, agent, model,
      connection: model?.enabled ? this.getConnection(model.connectionId) : undefined,
      userProfile: this.getSettings().userProfile,
      roleplayState: this.getConversationRoleplayState(conversation.id),
      generationKind
    });
  }

  createMessageGeneration(conversationId: string, text: string, assetIds: string[] = []): GenerationCreatedDto {
    return this.transaction(() => {
      const conversation = this.getConversation(conversationId);
      if (!conversation) throw new StoreError("conversation_not_found", "会话不存在");
      const generationKind = conversation.forkedFrom?.mode === "continue"
        && !this.sqlite.prepare("SELECT 1 FROM messages WHERE conversation_id = ? LIMIT 1").get(conversation.id)
        ? "continue"
        : "normal";
      const resolved = this.resolveGeneration(conversation, generationKind);
      return this.insertMessageGeneration(conversation, text, resolved.snapshot, assetIds);
    });
  }

  listQueuedMessages(conversationId: string): import("@llm-chat/contracts").QueuedMessageDto[] {
    if (!this.getConversation(conversationId)) throw new StoreError("conversation_not_found", "会话不存在");
    return (this.sqlite.prepare("SELECT * FROM queued_messages WHERE conversation_id = ? ORDER BY CASE WHEN mode = 'steer' THEN 0 ELSE 1 END, sequence").all(conversationId) as Row[])
      .map((row) => ({
        id: String(row.id), conversationId, text: String(row.text),
        mode: row.mode === "steer" ? "steer" : "queue",
        status: row.status as "pending" | "dispatching" | "failed", error: textOrNull(row.error),
        generationId: textOrNull(row.generation_id), createdAt: Number(row.created_at),
        attachments: (this.sqlite.prepare("SELECT asset_id FROM queued_message_assets WHERE queue_id = ? ORDER BY asset_index").all(String(row.id)) as Row[])
          .map((entry) => this.getFileAsset(String(entry.asset_id))!).filter(Boolean)
      }));
  }

  enqueueMessage(conversationId: string, text: string, assetIds: string[], mode: "queue" | "steer" = "queue") {
    return this.transaction(() => {
      if (!this.getConversation(conversationId)) throw new StoreError("conversation_not_found", "会话不存在");
      this.validateAttachments(assetIds);
      const id = randomUUID();
      this.sqlite.prepare(`INSERT INTO queued_messages(id, sequence, conversation_id, text, created_at)
        VALUES (?, (SELECT COALESCE(MAX(sequence), 0) + 1 FROM queued_messages), ?, ?, ?)`)
        .run(id, conversationId, text, Date.now());
      const insert = this.sqlite.prepare("INSERT INTO queued_message_assets(queue_id, asset_id, asset_index) VALUES (?, ?, ?)");
      assetIds.forEach((assetId, index) => insert.run(id, assetId, index));
      this.sqlite.prepare("UPDATE queued_messages SET mode = ? WHERE id = ?").run(mode, id);
      this.sqlite.prepare("UPDATE conversations SET draft = '' WHERE id = ?").run(conversationId);
      return this.listQueuedMessages(conversationId).find((item) => item.id === id)!;
    });
  }

  deleteQueuedMessages(conversationId: string, id?: string): void {
    if (!this.getConversation(conversationId)) throw new StoreError("conversation_not_found", "会话不存在");
    if (id && this.listQueuedMessages(conversationId).some((item) => item.id === id && item.status === "dispatching")) {
      throw new StoreError("queue_dispatching", "消息已经开始发送");
    }
    this.sqlite.prepare("DELETE FROM queued_messages WHERE conversation_id = ? AND status != 'dispatching' AND (? IS NULL OR id = ?)")
      .run(conversationId, id ?? null, id ?? null);
  }

  hasPendingSteer(conversationId: string): boolean {
    return Boolean(this.sqlite.prepare(`SELECT 1 FROM queued_messages q JOIN conversations c ON c.id = q.conversation_id
      WHERE q.conversation_id = ? AND q.mode = 'steer' AND q.status = 'pending' AND c.queue_paused = 0 LIMIT 1`).get(conversationId));
  }

  dispatchQueuedMessage(conversationId: string, validate: (assets: string[]) => void): GenerationCreatedDto | null {
    return this.transaction(() => {
      if (this.sqlite.prepare("SELECT queue_paused FROM conversations WHERE id = ?").get(conversationId)?.queue_paused) return null;
      if (this.isConversationBusy(conversationId)) return null;
      const item = this.listQueuedMessages(conversationId).find((item) => item.status === "pending");
      if (!item) return null;
      this.sqlite.exec("SAVEPOINT queue_dispatch");
      try {
        const ids = item.attachments.map((asset) => asset.id);
        validate(ids);
        const conversation = this.getConversation(conversationId)!;
        const result = this.insertMessageGeneration(conversation, item.text, this.resolveGeneration(conversation).snapshot, ids);
        this.sqlite.prepare("UPDATE conversations SET draft = ? WHERE id = ?").run(conversation.draft, conversationId);
        this.sqlite.prepare("UPDATE queued_messages SET status = 'dispatching', generation_id = ? WHERE id = ?").run(result.generationId, item.id);
        this.sqlite.exec("RELEASE queue_dispatch");
        return result;
      } catch (error) {
        this.sqlite.exec("ROLLBACK TO queue_dispatch; RELEASE queue_dispatch");
        this.sqlite.prepare("UPDATE queued_messages SET status = 'failed', error = ? WHERE id = ?")
          .run(error instanceof Error ? error.message : "消息发送失败", item.id);
        return null;
      }
    });
  }

  createRetryGeneration(assistantMessageId: string): GenerationCreatedDto {
    return this.transaction(() => {
      const message = this.sqlite.prepare("SELECT * FROM messages WHERE id = ? AND role = 'assistant' AND history_active = 1").get(assistantMessageId) as Row | undefined;
      if (!message) throw new StoreError("message_not_found", "助手消息不存在");
      const conversation = this.getConversation(String(message.conversation_id));
      if (!conversation) throw new StoreError("conversation_not_found", "会话不存在");
      const { model, connection, snapshot } = this.resolveGeneration(conversation, "regenerate");
      const max = this.sqlite.prepare("SELECT COALESCE(MAX(version), 0) AS value FROM generations WHERE assistant_message_id = ?").get(assistantMessageId) as Row;
      const generationId = randomUUID();
      this.insertGeneration(generationId, assistantMessageId, Number(max.value) + 1, connection, model, snapshot, Date.now());
      this.sqlite.prepare("UPDATE messages SET active_generation_id = ? WHERE id = ?").run(generationId, assistantMessageId);
      return { assistantMessageId, generationId };
    });
  }

  conversationIdForMessage(messageId: string): string | undefined {
    const row = this.sqlite.prepare("SELECT conversation_id FROM messages WHERE id = ?").get(messageId) as Row | undefined;
    return row ? String(row.conversation_id) : undefined;
  }

  isConversationBusy(conversationId: string): boolean {
    return Boolean(this.sqlite.prepare(`
      SELECT 1 FROM generations g JOIN messages m ON m.id = g.assistant_message_id
      WHERE m.conversation_id = ? AND g.status IN ('queued', 'running', 'waiting-approval') LIMIT 1
    `).get(conversationId));
  }

  private insertGeneration(
    id: string,
    assistantMessageId: string,
    version: number,
    connection: ConnectionRecord,
    model: ModelDto,
    snapshot: AgentSnapshot,
    now: number
  ): void {
    this.sqlite.prepare(`
      INSERT INTO generations (id, assistant_message_id, version, status, connection_id, model_id,
        connection_name, protocol, model_key, model_display_name, settings_json,
        agent_id, agent_name, agent_revision, agent_snapshot_json, generation_kind, created_at)
      VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, assistantMessageId, version, connection.id, model.id, connection.name, connection.protocol, model.modelKey,
      model.displayName, json(snapshot.execution.settings), snapshot.agentId, snapshot.name, snapshot.revision,
      json(snapshot), snapshot.generationKind, now);
  }

  private insertMessageGeneration(
    conversation: ConversationDto,
    text: string,
    snapshot: AgentSnapshot,
    assetIds: string[] = []
  ): GenerationCreatedDto {
    const model = this.getModel(snapshot.execution.modelId);
    const connection = model?.enabled ? this.getConnection(model.connectionId) : undefined;
    if (!model || !connection) throw new StoreError("conversation_model_required", "会话当前模型不可用，请重新选择");
    const now = Date.now();
    const max = this.sqlite.prepare("SELECT COALESCE(MAX(ordinal), 0) AS value FROM messages WHERE conversation_id = ?").get(conversation.id) as Row;
    const userMessageId = randomUUID();
    const assistantMessageId = randomUUID();
    const generationId = randomUUID();
    const userOrdinal = Number(max.value) + 1;
    this.sqlite.prepare(`
      INSERT INTO messages (id, conversation_id, ordinal, role, text, active_generation_id, created_at)
      VALUES (?, ?, ?, 'user', ?, NULL, ?)
    `)
      .run(userMessageId, conversation.id, userOrdinal, text, now);
    this.attachFilesToMessage(userMessageId, assetIds);
    this.sqlite.prepare(`
      INSERT INTO messages (id, conversation_id, ordinal, role, text, active_generation_id, created_at)
      VALUES (?, ?, ?, 'assistant', NULL, ?, ?)
    `)
      .run(assistantMessageId, conversation.id, userOrdinal + 1, generationId, now);
    this.insertGeneration(generationId, assistantMessageId, 1, connection, model, snapshot, now);
    const titleSource = text || this.getFileAsset(assetIds[0] ?? "")?.fileName || "文件对话";
    const title = conversation.title === "新对话" ? titleFrom(titleSource) : conversation.title;
    this.sqlite.prepare("UPDATE conversations SET title = ?, draft = '', updated_at = ? WHERE id = ?")
      .run(title, now, conversation.id);
    return { userMessageId, assistantMessageId, generationId };
  }

  selectGeneration(messageId: string, generationId: string): boolean {
    const result = this.sqlite.prepare(`
      UPDATE messages SET active_generation_id = ?
      WHERE id = ? AND history_active = 1 AND EXISTS (SELECT 1 FROM generations WHERE id = ? AND assistant_message_id = messages.id)
    `).run(generationId, messageId, generationId);
    if (Number(result.changes)) {
      const conversation = this.sqlite.prepare("SELECT conversation_id FROM messages WHERE id = ?").get(messageId) as Row;
      this.sqlite.prepare("DELETE FROM context_summaries WHERE conversation_id = ?").run(String(conversation.conversation_id));
    }
    return Number(result.changes) > 0;
  }

  isQueuePaused(conversationId: string): boolean {
    const row = this.sqlite.prepare("SELECT queue_paused FROM conversations WHERE id = ?").get(conversationId);
    if (!row) throw new StoreError("conversation_not_found", "会话不存在");
    return Boolean(row.queue_paused);
  }

  resumeQueue(conversationId: string): void {
    this.isQueuePaused(conversationId);
    this.sqlite.prepare("UPDATE conversations SET queue_paused = 0 WHERE id = ?").run(conversationId);
  }

  listMessages(conversationId: string, includeInactive = false): MessageDto[] {
    const messages = this.sqlite.prepare("SELECT * FROM messages WHERE conversation_id = ? AND (? OR history_active = 1) ORDER BY ordinal").all(conversationId, Number(includeInactive)) as Row[];
    return messages.map((message) => {
      const assistant = message.role === "assistant";
      const activeGenerationId = textOrNull(message.active_generation_id);
      return {
        id: String(message.id),
        ordinal: Number(message.ordinal),
        role: message.role as "user" | "assistant",
        text: textOrNull(message.text),
        attachments: this.messageFiles(String(message.id)),
        generatedModel: assistant && activeGenerationId ? this.generatedModel(activeGenerationId) : null,
        activeGenerationId,
        generations: assistant ? this.listGenerations(String(message.id)) : [],
        greeting: message.greeting_json
          ? greetingMessageSchema.safeParse(parse(message.greeting_json, null)).data ?? null
          : null,
        imageGenerationJob: assistant ? this.imageGenerationJobForMessage(String(message.id)) : null,
        createdAt: Number(message.created_at)
      };
    });
  }

  private generatedModel(generationId: string): GeneratedModelDto | null {
    const row = this.sqlite.prepare(`
      SELECT model_id, model_display_name, model_key, connection_name, protocol FROM generations WHERE id = ?
    `).get(generationId) as Row | undefined;
    return row ? {
      modelId: String(row.model_id),
      displayName: String(row.model_display_name ?? row.model_key),
      modelKey: String(row.model_key),
      connectionName: String(row.connection_name),
      protocol: row.protocol as ProviderProtocol
    } : null;
  }

  private imageGenerationJobForMessage(messageId: string): ImageGenerationJobDto | null {
    const row = this.sqlite.prepare(
      "SELECT * FROM image_generation_jobs WHERE assistant_message_id = ? ORDER BY created_at DESC LIMIT 1"
    ).get(messageId) as Row | undefined;
    return row ? imageGenerationJobDto(row, this) : null;
  }

  private listGenerations(messageId: string): GenerationDto[] {
    return (this.sqlite.prepare("SELECT * FROM generations WHERE assistant_message_id = ? ORDER BY version").all(messageId) as Row[])
      .map((row) => this.generationDto(row));
  }

  getGeneration(id: string): GenerationDto | undefined {
    const row = this.sqlite.prepare("SELECT * FROM generations WHERE id = ?").get(id) as Row | undefined;
    return row ? this.generationDto(row) : undefined;
  }

  getGenerationRecord(id: string): GenerationRecord | undefined {
    const row = this.sqlite.prepare(`
      SELECT g.*, m.conversation_id FROM generations g JOIN messages m ON m.id = g.assistant_message_id WHERE g.id = ?
    `).get(id) as Row | undefined;
    if (!row) return undefined;
    const conversation = this.getConversation(String(row.conversation_id));
    const currentAgent = conversation?.agentId ? this.getAgent(conversation.agentId) : undefined;
    const legacySnapshot: AgentSnapshot = {
      agentId: currentAgent?.id ?? null,
      name: currentAgent?.name ?? String(row.agent_name ?? "默认助手"),
      revision: currentAgent?.revision ?? Number(row.agent_revision ?? 1),
      card: currentAgent?.card ?? defaultAgentCard(),
      userProfile: currentAgent ? this.resolvedUserProfile(currentAgent) : this.getSettings().userProfile,
      baseSystemPrompt: String((this.sqlite.prepare("SELECT default_system_prompt FROM app_settings WHERE id = 1").get() as Row).default_system_prompt),
      roleplay: currentAgent?.roleplay ?? defaultRoleplayConfig(false),
      roleplayState: currentAgent && conversation
        ? this.getConversationRoleplayState(conversation.id)
        : conversationRoleplayStateSchema.parse({}),
      generationKind: (row.generation_kind ?? "normal") as RoleplayGenerationTrigger,
      workspacePath: conversation?.workspacePath ?? null,
      extensionsPinned: false,
      skillRevisions: {},
      toolRevisions: {},
      execution: {
        search: agentSearchConfigSchema.parse({}),
        modelId: String(row.model_id),
        visionModelId: null,
        contextPolicy: conversation?.contextPolicy ?? "trim",
        reasoningEffort: parseGenerationSettings(row.settings_json).reasoningEffort,
        settings: parseGenerationSettings(row.settings_json),
        tools: { defaultEnabled: true, overrides: {}, directOverrides: {}, approvalOverrides: {} },
        enabledSkillIds: [],
        maxToolRounds: 8,
        maxBackgroundTasks: 2,
        taskLogLimitBytes: 64 * 1024 * 1024
      }
    };
    const savedSnapshot = row.agent_snapshot_json
      ? parse<Partial<AgentSnapshot>>(row.agent_snapshot_json, {})
      : {};
    const agentSnapshot: AgentSnapshot = {
      ...legacySnapshot,
      ...savedSnapshot,
      roleplay: parseRoleplayConfig(savedSnapshot.roleplay, false),
      roleplayState: resolveRoleplayState(
        parseRoleplayConfig(savedSnapshot.roleplay, false),
        savedSnapshot.roleplayState
      ),
      generationKind: savedSnapshot.generationKind ?? legacySnapshot.generationKind,
      execution: {
        ...legacySnapshot.execution,
        ...(savedSnapshot.execution ?? {}),
        search: agentSearchConfigSchema.parse(savedSnapshot.execution?.search ?? legacySnapshot.execution.search)
      }
    };
    return {
      id: String(row.id),
      assistantMessageId: String(row.assistant_message_id),
      conversationId: String(row.conversation_id),
      connectionId: String(row.connection_id),
      modelId: String(row.model_id),
      modelKey: String(row.model_key),
      protocol: row.protocol as ProviderProtocol,
      settings: parseGenerationSettings(row.settings_json),
      generationKind: (row.generation_kind ?? "normal") as RoleplayGenerationTrigger,
      agentSnapshot,
      status: row.status as GenerationDto["status"]
    };
  }

  updateGenerationExtensionSnapshot(id: string, snapshot: AgentSnapshot): void {
    this.sqlite.prepare("UPDATE generations SET agent_snapshot_json = ? WHERE id = ?").run(json(snapshot), id);
  }

  setGenerationRunning(id: string): void {
    this.sqlite.prepare(`
      UPDATE generations SET status = 'running', started_at = COALESCE(started_at, ?), completed_at = NULL
      WHERE id = ? AND status IN ('queued', 'waiting-approval')
    `).run(Date.now(), id);
  }

  setGenerationWaitingApproval(id: string): void {
    this.sqlite.prepare("UPDATE generations SET status = 'waiting-approval' WHERE id = ?").run(id);
  }

  upsertToolCall(
    generationId: string,
    call: { id: string; name: string; arguments: string },
    index: number,
    stepIndex: number,
    requiresApproval: boolean
  ): ToolCallDto {
    const state = requiresApproval ? "pending" : "auto";
    const existing = this.sqlite.prepare("SELECT generation_id, step_index FROM generation_tool_calls WHERE id = ?").get(call.id) as Row | undefined;
    const id = existing && (String(existing.generation_id) !== generationId || Number(existing.step_index) !== stepIndex) ? randomUUID() : call.id;
    this.sqlite.prepare(`
      INSERT INTO generation_tool_calls
        (id, generation_id, call_index, step_index, name, arguments_json, approval_state, requires_approval, provider_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, arguments_json = excluded.arguments_json,
        provider_id = excluded.provider_id
    `).run(id, generationId, index, stepIndex, call.name, call.arguments, state, requiresApproval ? 1 : 0, call.id);
    return this.getToolCall(id)!;
  }

  getToolCall(id: string): ToolCallDto | undefined {
    const row = this.sqlite.prepare("SELECT * FROM generation_tool_calls WHERE id = ?").get(id) as Row | undefined;
    return row ? toolCallDto(row, this.toolCallFiles(id)) : undefined;
  }

  listToolCalls(generationId: string): ToolCallDto[] {
    return (this.sqlite.prepare(`
      SELECT * FROM generation_tool_calls WHERE generation_id = ? ORDER BY call_index
    `).all(generationId) as Row[]).map((row) => toolCallDto(row, this.toolCallFiles(String(row.id))));
  }

  setGenerationStepContext(generationId: string, stepIndex: number, payload: unknown): void {
    this.sqlite.prepare(`
      INSERT INTO generation_steps (generation_id, step_index, provider_context_json) VALUES (?, ?, ?)
      ON CONFLICT(generation_id, step_index) DO UPDATE SET provider_context_json = excluded.provider_context_json
    `).run(generationId, stepIndex, json(payload));
  }

  currentGenerationMessages(generationId: string): ContextGenerationStep[] {
    const generation = this.sqlite.prepare("SELECT * FROM generations WHERE id = ?").get(generationId) as Row | undefined;
    if (!generation) return [];
    const calls = this.listToolCalls(generationId);
    const blocks = this.sqlite.prepare("SELECT * FROM generation_blocks WHERE generation_id = ? ORDER BY block_index")
      .all(generationId) as Row[];
    const contexts = this.sqlite.prepare("SELECT * FROM generation_steps WHERE generation_id = ? ORDER BY step_index")
      .all(generationId) as Row[];
    const indices = [...new Set([
      ...calls.map((call) => call.stepIndex),
      ...blocks.map((block) => Number(block.step_index ?? Math.floor(Number(block.block_index) / 1000))),
      ...contexts.map((step) => Number(step.step_index))
    ])].sort((a, b) => a - b);
    if (!indices.length && generation.provider_context_json) indices.push(0);
    const messages: ContextGenerationStep[] = [];
    for (const index of indices) {
      const stepCalls = calls.filter((call) => call.stepIndex === index);
      const stepBlocks = blocks.filter((block) => Number(block.step_index ?? Math.floor(Number(block.block_index) / 1000)) === index);
      const context = contexts.find((step) => Number(step.step_index) === index)?.provider_context_json
        ?? (index === indices.at(-1) ? generation.provider_context_json : undefined);
      const text = stepBlocks.filter((block) => block.type === "text" || block.type === "refusal")
        .map((block) => String(block.content)).join("");
      if (text || stepCalls.length || context) messages.push({
        role: "assistant", text,
        ...(stepCalls.length ? { toolCalls: stepCalls.map((call) => ({ id: call.providerId ?? call.id, name: call.name, arguments: call.arguments })) } : {}),
        ...(context ? { providerPayload: parse(context, undefined) } : {}),
        providerConnectionId: String(generation.connection_id),
        providerProtocol: generation.protocol as ProviderProtocol,
        providerModelKey: String(generation.model_key)
      });
      const results = stepCalls.filter((call) => call.output !== null || call.error !== null).map((call) => ({
        callId: call.providerId ?? call.id, name: call.name,
        content: call.output ?? JSON.stringify({ error: call.error }),
        ...(call.error ? { isError: true } : {})
      }));
      const imageAssets = stepCalls.flatMap((call) => this.toolCallImages(call.id));
      if (results.length) messages.push({ role: "tool", text: "", toolResults: results,
        ...(imageAssets.length ? { imageAssets } : {}) });
    }
    return messages;
  }

  currentGenerationContext(generationId: string): ContextMessageRecord | undefined {
    const row = this.sqlite.prepare(`SELECT m.* FROM messages m JOIN generations g ON g.assistant_message_id = m.id WHERE g.id = ?`)
      .get(generationId) as Row | undefined;
    if (!row) return undefined;
    const steps = this.currentGenerationMessages(generationId);
    return {
      messageId: String(row.id), ordinal: Number(row.ordinal), role: "assistant",
      text: steps.filter((step) => step.role === "assistant").map((step) => step.text).join(""), steps,
      images: [...steps.flatMap((step) => step.imageAssets ?? []), ...this.messageImages(String(row.id))],
      files: this.messageFiles(String(row.id)).filter((asset) => asset.kind === "file")
    };
  }

  updateToolCall(
    id: string,
    patch: { presentation?: ToolCallDto["presentation"]; approvalState?: ToolCallDto["approvalState"]; output?: string | null; error?: string | null; startedAt?: number | null; completedAt?: number | null }
  ): ToolCallDto | undefined {
    const current = this.getToolCall(id);
    if (!current) return undefined;
    this.sqlite.prepare(`
      UPDATE generation_tool_calls SET approval_state = ?, output = ?, error = ?, started_at = ?, completed_at = ?, presentation_json = ? WHERE id = ?
    `).run(
      patch.approvalState ?? current.approvalState,
      patch.output === undefined ? current.output : patch.output,
      patch.error === undefined ? current.error : patch.error,
      patch.startedAt === undefined ? current.startedAt : patch.startedAt,
      patch.completedAt === undefined ? current.completedAt : patch.completedAt,
      json(patch.presentation ?? current.presentation ?? {}),
      id
    );
    return this.getToolCall(id);
  }

  generationIdForToolCall(id: string): string | undefined {
    const row = this.sqlite.prepare("SELECT generation_id FROM generation_tool_calls WHERE id = ?").get(id) as Row | undefined;
    return row ? String(row.generation_id) : undefined;
  }

  updateGenerationBlock(id: string, index: number, type: string, content: string, complete: boolean, providerPayload?: unknown): void {
    const stepIndex = Math.floor(index / 1000);
    const existing = this.sqlite.prepare("SELECT id FROM generation_blocks WHERE generation_id = ? AND block_index = ?").get(id, index) as Row | undefined;
    if (existing) {
      this.sqlite.prepare(`
        UPDATE generation_blocks SET step_index = ?, type = ?, content = ?, complete = ?, provider_payload_json = ? WHERE id = ?
      `).run(stepIndex, type, content, complete ? 1 : 0, providerPayload === undefined ? null : json(providerPayload), String(existing.id));
    } else {
      this.sqlite.prepare(`
        INSERT INTO generation_blocks (id, generation_id, block_index, step_index, type, content, complete, provider_payload_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(randomUUID(), id, index, stepIndex, type, content, complete ? 1 : 0, providerPayload === undefined ? null : json(providerPayload));
    }
  }

  updateGenerationUsage(id: string, usage: UsageDto): void {
    this.sqlite.prepare("UPDATE generations SET usage_json = ? WHERE id = ?").run(json(usage), id);
  }

  setGenerationContext(id: string, context: GenerationDto["context"]): void {
    this.sqlite.prepare("UPDATE generations SET context_json = ? WHERE id = ?").run(json(context), id);
  }

  setProviderContext(id: string, payload: unknown): void {
    this.sqlite.prepare("UPDATE generations SET provider_context_json = ? WHERE id = ?").run(json(payload), id);
  }

  finishGeneration(id: string, status: "completed" | "stopped" | "failed", options: { stopReason?: string; code?: string; message?: string }): void {
    const completedAt = Date.now();
    this.transaction(() => {
      this.sqlite.prepare(`
        UPDATE generations SET status = ?, stop_reason = ?, error_code = ?, error_message = ?, completed_at = ? WHERE id = ?
      `).run(status, options.stopReason ?? null, options.code ?? null, options.message ?? null, completedAt, id);
      const failure = options.stopReason === "cancelled"
        ? "Generation cancelled before tool execution"
        : `Generation ${status} before tool execution completed`;
      repairTerminalToolCalls(
        this.sqlite,
        completedAt,
        failure,
        options.stopReason === "cancelled" ? failure : undefined,
        id
      );
    });
  }

  contextMessages(conversationId: string, beforeAssistantMessageId: string): ContextMessageRecord[] {
    const target = this.sqlite.prepare("SELECT ordinal FROM messages WHERE id = ? AND conversation_id = ? AND history_active = 1").get(beforeAssistantMessageId, conversationId) as Row | undefined;
    if (!target) return [];
    return this.contextMessagesThrough(conversationId, Number(target.ordinal) - 1);
  }

  allContextMessages(conversationId: string): ContextMessageRecord[] {
    const max = this.sqlite.prepare("SELECT COALESCE(MAX(ordinal), 0) AS ordinal FROM messages WHERE conversation_id = ?")
      .get(conversationId) as Row;
    return this.contextMessagesThrough(conversationId, Number(max.ordinal));
  }

  private contextMessagesThrough(conversationId: string, throughOrdinal: number): ContextMessageRecord[] {
    const rows = this.sqlite.prepare(`
      SELECT m.*, g.id AS generation_id
      FROM messages m
      LEFT JOIN generations g ON g.id = m.active_generation_id
      WHERE m.conversation_id = ? AND m.history_active = 1 AND m.ordinal <= ?
      ORDER BY m.ordinal
    `).all(conversationId, throughOrdinal) as Row[];
    return rows.flatMap((row): ContextMessageRecord[] => {
      const imageJob = this.sqlite.prepare(`SELECT j.*, tc.generation_id AS owner_generation_id
        FROM image_generation_jobs j LEFT JOIN generation_tool_calls tc ON tc.id = j.tool_call_id
        WHERE j.assistant_message_id = ? LIMIT 1`).get(String(row.id)) as Row | undefined;
      // Tool-owned images are replayed with that tool's selected generation, never as independent turns.
      if (imageJob?.owner_generation_id) return [];
      if (row.generation_id) return [this.currentGenerationContext(String(row.generation_id))!];
      let text = String(row.text ?? "");
      const images = this.messageImages(String(row.id));
      const files = this.messageFiles(String(row.id)).filter((asset) => asset.kind === "file");
      if (imageJob && !images.length) text ||= `[图片生成任务：${String(imageJob.status)}${imageJob.error_message ? `；${String(imageJob.error_message)}` : ""}]`;
      if (row.role === "assistant" && !text.trim() && !images.length && !files.length) return [];
      return [{ messageId: String(row.id), ordinal: Number(row.ordinal), role: row.role as "user" | "assistant", text, images, files }];
    });
  }

  listMemories(): Array<{ id: number; content: string; createdAt: number; updatedAt: number }> {
    return (this.sqlite.prepare("SELECT * FROM memories ORDER BY updated_at DESC").all() as Row[]).map((row) => ({
      id: Number(row.id), content: String(row.content), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at)
    }));
  }

  createMemory(content: string): { id: number; content: string; createdAt: number; updatedAt: number } {
    const now = Date.now();
    const result = this.sqlite.prepare("INSERT INTO memories (content, created_at, updated_at) VALUES (?, ?, ?)")
      .run(content, now, now);
    return this.listMemories().find((item) => item.id === Number(result.lastInsertRowid))!;
  }

  updateMemory(id: number, content: string): { id: number; content: string; createdAt: number; updatedAt: number } {
    const result = this.sqlite.prepare("UPDATE memories SET content = ?, updated_at = ? WHERE id = ?")
      .run(content, Date.now(), id);
    if (!Number(result.changes)) throw new StoreError("memory_not_found", `记忆 #${id} 不存在`);
    return this.listMemories().find((item) => item.id === id)!;
  }

  deleteMemory(id: number): void {
    const result = this.sqlite.prepare("DELETE FROM memories WHERE id = ?").run(id);
    if (!Number(result.changes)) throw new StoreError("memory_not_found", `记忆 #${id} 不存在`);
  }

  recentChats(limit: number): Array<{ id: string; title: string; updatedAt: number }> {
    return (this.sqlite.prepare("SELECT id, title, updated_at FROM conversations ORDER BY updated_at DESC LIMIT ?")
      .all(limit) as Row[]).map((row) => ({ id: String(row.id), title: String(row.title), updatedAt: Number(row.updated_at) }));
  }

  searchChats(query: string, limit: number): Array<{ conversationId: string; title: string; snippet: string; updatedAt: number }> {
    const pattern = `%${query.replace(/[\\%_]/g, "\\$&")}%`;
    const rows = this.sqlite.prepare(`
      SELECT c.id AS conversation_id, c.title, c.updated_at,
        CASE WHEN m.role = 'user' THEN m.text ELSE (
          SELECT GROUP_CONCAT(b.content, '') FROM generation_blocks b
          JOIN generations g2 ON g2.id = b.generation_id
          WHERE g2.id = m.active_generation_id AND b.type IN ('text','refusal')
        ) END AS content
      FROM messages m JOIN conversations c ON c.id = m.conversation_id
      WHERE m.history_active = 1 AND COALESCE(CASE WHEN m.role = 'user' THEN m.text ELSE (
        SELECT GROUP_CONCAT(b.content, '') FROM generation_blocks b
        JOIN generations g3 ON g3.id = b.generation_id
        WHERE g3.id = m.active_generation_id AND b.type IN ('text','refusal')
      ) END, '') LIKE ? ESCAPE '\\'
      ORDER BY c.updated_at DESC LIMIT ?
    `).all(pattern, limit) as Row[];
    return rows.map((row) => {
      const content = String(row.content ?? "").replace(/\s+/g, " ");
      const position = content.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
      const start = Math.max(0, position - 80);
      return {
        conversationId: String(row.conversation_id),
        title: String(row.title),
        snippet: content.slice(start, start + 240),
        updatedAt: Number(row.updated_at)
      };
    });
  }

  getLatestSummary(conversationId: string): (ContextSummaryDto & { sourceFingerprint: string }) | undefined {
    const row = this.sqlite.prepare(`
      SELECT * FROM context_summaries WHERE conversation_id = ? AND through_ordinal <=
        (SELECT COALESCE(MAX(ordinal), 0) FROM messages WHERE conversation_id = context_summaries.conversation_id AND history_active = 1)
      ORDER BY through_ordinal DESC LIMIT 1
    `).get(conversationId) as Row | undefined;
    return row ? {
      id: String(row.id),
      conversationId: String(row.conversation_id),
      throughOrdinal: Number(row.through_ordinal),
      sourceFingerprint: String(row.source_fingerprint),
      text: String(row.text),
      connectionId: String(row.connection_id),
      modelKey: String(row.model_key),
      usage: parse(row.usage_json, {}),
      createdAt: Number(row.created_at)
    } : undefined;
  }

  getContextSummary(conversationId: string): ContextSummaryDto | undefined {
    const summary = this.getLatestSummary(conversationId);
    if (!summary) return undefined;
    const { sourceFingerprint: _sourceFingerprint, ...dto } = summary;
    return dto;
  }

  saveSummary(input: { conversationId: string; throughOrdinal: number; fingerprint: string; text: string; connectionId: string; modelKey: string; usage: UsageDto }): string {
    const id = randomUUID();
    this.sqlite.prepare(`
      INSERT INTO context_summaries (id, conversation_id, through_ordinal, source_fingerprint, text, connection_id, model_key, usage_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, input.conversationId, input.throughOrdinal, input.fingerprint, input.text, input.connectionId, input.modelKey, json(input.usage), Date.now());
    return id;
  }

  private transaction<T>(action: () => T): T {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      this.sqlite.exec("COMMIT");
      return result;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  private visionAnalysisDto(row: Row, cached: boolean): VisionAnalysisDto {
    const asset = this.getImageAsset(String(row.asset_id));
    if (!asset) throw new StoreError("image_asset_not_found", "识图记录关联的图片资产不存在");
    return {
      id: String(row.id),
      asset,
      status: row.status as VisionAnalysisDto["status"],
      model: {
        modelId: String(row.model_id),
        displayName: String(row.model_display_name),
        modelKey: String(row.model_key),
        connectionName: String(row.connection_name),
        protocol: row.protocol as ProviderProtocol
      },
      description: textOrNull(row.description),
      usage: parse(row.usage_json, {}),
      cached,
      error: textOrNull(row.error),
      createdAt: Number(row.created_at),
      completedAt: row.completed_at === null ? null : Number(row.completed_at)
    };
  }

  private generationDto(row: Row): GenerationDto {
    const blocks = this.sqlite.prepare("SELECT * FROM generation_blocks WHERE generation_id = ? ORDER BY block_index").all(String(row.id)) as Row[];
    const snapshot = row.agent_snapshot_json ? parse<Partial<AgentSnapshot>>(row.agent_snapshot_json, {}) : {};
    const roleplay = parseRoleplayConfig(snapshot.roleplay, false);
    const roleplayState = resolveRoleplayState(roleplay, snapshot.roleplayState);
    const display = (content: string) => roleplay.enabled
      ? applySafeRegex(content, roleplay.regexScripts, roleplayState.enabledRegexScriptIds, "display")
      : content;
    return {
      id: String(row.id),
      version: Number(row.version),
      generationKind: (row.generation_kind ?? "normal") as RoleplayGenerationTrigger,
      status: row.status as GenerationDto["status"],
      connectionName: String(row.connection_name),
      protocol: row.protocol as ProviderProtocol,
      modelKey: String(row.model_key),
      settings: parseGenerationSettings(row.settings_json),
      generatedAgent: row.agent_name ? {
        agentId: textOrNull(row.agent_id),
        name: String(row.agent_name),
        revision: Number(row.agent_revision ?? 1)
      } : null,
      blocks: blocks.map((block) => ({
        id: String(block.id),
        index: Number(block.block_index),
        stepIndex: Number(block.step_index ?? Math.floor(Number(block.block_index) / 1000)),
        type: block.type as GenerationDto["blocks"][number]["type"],
        content: display(String(block.content)),
        complete: Boolean(block.complete)
      })),
      toolCalls: this.listToolCalls(String(row.id)),
      visionAnalyses: this.generationVisionAnalyses(String(row.id)),
      usage: parse(row.usage_json, {}),
      stopReason: textOrNull(row.stop_reason),
      error: row.error_code ? { code: String(row.error_code), message: String(row.error_message) } : null,
      context: row.context_json ? parse(row.context_json, null) : null,
      createdAt: Number(row.created_at),
      completedAt: row.completed_at === null ? null : Number(row.completed_at)
    };
  }
}

type Row = Record<string, unknown>;

function connectionDto(row: Row): ConnectionDto {
  const secretHeaders = parse<Record<string, string>>(row.secret_headers_json, {});
  const balanceConfig = parseBalanceConfig(row.balance_config_json);
  const providerId = providerPresetIdSchema.safeParse(row.provider_id ?? "custom");
  return {
    id: String(row.id),
    name: String(row.name),
    providerId: providerId.success ? providerId.data : "custom",
    protocol: row.protocol as ProviderProtocol,
    baseUrl: String(row.base_url),
    hasApiKey: Boolean(row.api_key),
    secretHeaderNames: Object.keys(secretHeaders),
    ...(balanceConfig ? { balanceConfig } : {}),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at)
  };
}

function parseBalanceConfig(value: unknown): BalanceConfig | undefined {
  const result = balanceConfigSchema.safeParse(parse(value, {}));
  return result.success ? result.data : undefined;
}

function connectionRecord(row: Row): ConnectionRecord {
  return {
    ...connectionDto(row),
    apiKey: String(row.api_key),
    secretHeaders: parse(row.secret_headers_json, {})
  };
}

function modelDto(row: Row): ModelDto {
  return {
    id: String(row.id),
    connectionId: String(row.connection_id),
    modelKey: String(row.model_key),
    displayName: String(row.display_name),
    contextWindow: row.context_window === null ? null : Number(row.context_window),
    maxInputTokens: row.max_input_tokens === null || row.max_input_tokens === undefined ? null : Number(row.max_input_tokens),
    maxOutputTokens: Number(row.max_output_tokens),
    imageProtocol: row.image_protocol ? row.image_protocol as ModelDto["imageProtocol"] : null,
    capabilities: modelCapabilitiesSchema.parse(parse(row.capabilities_json, {})),
    defaultSettings: parseModelSettings(row.default_settings_json),
    source: row.source as ModelDto["source"],
    catalogManaged: Boolean(row.catalog_managed),
    catalogMetadata: row.catalog_metadata_json
      ? modelCatalogMetadataSchema.safeParse(parse(row.catalog_metadata_json, null)).data ?? null
      : null,
    enabled: Boolean(row.enabled),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at)
  };
}

function imageGenerationJobDto(row: Row, store: Store): ImageGenerationJobDto {
  const outputIds = parse<unknown>(row.output_asset_ids_json, []);
  const outputAssets = Array.isArray(outputIds)
    ? outputIds.flatMap((id) => typeof id === "string" ? [store.getImageAsset(id)].filter(Boolean) as ImageAssetDto[] : [])
    : [];
  const status = imageGenerationJobStatusSchema.parse(String(row.status));
  const operation = imageGenerationOperationSchema.parse(String(row.operation));
  const imageProtocol = imageProviderProtocolSchema.parse(String(row.image_protocol));
  const errorCode = textOrNull(row.error_code);
  const errorMessage = textOrNull(row.error_message);
  return {
    id: String(row.id),
    conversationId: String(row.conversation_id),
    assistantMessageId: String(row.assistant_message_id),
    toolCallId: textOrNull(row.tool_call_id),
    modelId: String(row.model_id),
    modelKey: String(row.model_key),
    connectionName: String(row.connection_name),
    imageProtocol,
    operation,
    prompt: String(row.prompt),
    status,
    progress: row.progress === null || row.progress === undefined ? null : Number(row.progress),
    providerJobId: textOrNull(row.provider_job_id),
    outputAssets,
    revisedPrompt: textOrNull(row.revised_prompt),
    error: errorCode && errorMessage ? { code: errorCode, message: errorMessage } : null,
    createdAt: Number(row.created_at),
    startedAt: row.started_at === null || row.started_at === undefined ? null : Number(row.started_at),
    completedAt: row.completed_at === null || row.completed_at === undefined ? null : Number(row.completed_at)
  };
}

function conversationDto(row: Row): ConversationDto {
  const executionOverrides = conversationExecutionOverridesSchema.parse(parse(row.execution_overrides_json, {}));
  const agentExecution = row.agent_execution_json
    ? agentExecutionConfigSchema.parse(parse(row.agent_execution_json, {}))
    : undefined;
  return {
    id: String(row.id),
    title: String(row.title),
    systemPrompt: String(row.system_prompt),
    contextPolicy: executionOverrides.contextPolicy ?? agentExecution?.contextPolicy ?? row.context_policy as ContextPolicy,
    modelId: Object.hasOwn(executionOverrides, "modelId")
      ? executionOverrides.modelId ?? null
      : agentExecution?.modelId ?? textOrNull(row.model_id),
    agentId: textOrNull(row.agent_id),
    executionOverrides,
    workspacePath: textOrNull(row.workspace_path),
    forkedFrom: row.parent_conversation_id ? {
      conversationId: String(row.parent_conversation_id),
      messageId: textOrNull(row.forked_from_message_id),
      messageOrdinal: row.fork_point_ordinal === null || row.fork_point_ordinal === undefined
        ? null
        : Number(row.fork_point_ordinal),
      mode: row.fork_mode === "edit" || row.fork_mode === "greeting" ? row.fork_mode : "continue",
      greetingIndex: row.fork_greeting_index === null || row.fork_greeting_index === undefined
        ? null
        : Number(row.fork_greeting_index),
      sourceGreetingIndex: row.fork_source_greeting_index === null || row.fork_source_greeting_index === undefined
        ? null
        : Number(row.fork_source_greeting_index)
    } : null,
    draft: String(row.draft),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at)
  };
}

function agentDto(row: Row, searchApiKeyConfigured = false): AgentDto {
  const card = characterCardV2Schema.parse(parse(row.card_json, {}));
  return {
    ...agentSummaryDto(row, searchApiKeyConfigured),
    card,
    roleplay: parseRoleplayConfig(row.roleplay_json, false)
  };
}

function agentSummaryDto(row: Row, searchApiKeyConfigured = false): AgentSummaryDto {
  const card = characterCardV2Schema.parse(parse(row.card_json, {}));
  const execution = agentExecutionConfigSchema.parse(parse(row.execution_json, {}));
  const roleplay = parseRoleplayConfig(row.roleplay_json, false);
  return {
    id: String(row.id), name: card.data.name, description: card.data.description,
    protected: Boolean(row.protected), revision: Number(row.revision),
    hasAvatar: row.avatar_png !== null && row.avatar_png !== undefined,
    modelId: execution.modelId, execution,
    lastSelectedModelId: textOrNull(row.last_selected_model_id),
    searchApiKeyConfigured,
    userProfile: agentUserProfileOverrideSchema.parse(parse(row.user_profile_json, {})),
    firstMessage: card.data.first_mes, alternateGreetings: card.data.alternate_greetings,
    roleplayEnabled: roleplay.enabled,
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at)
  };
}

function defaultAgentCard(): CharacterCardV2 {
  return {
    spec: "chara_card_v2",
    spec_version: "2.0",
    data: {
      name: "默认助手",
      description: "通用聊天与日常工作助手。",
      personality: "",
      scenario: "",
      first_mes: "你好，有什么可以帮你？",
      mes_example: "",
      creator_notes: "",
      system_prompt: "{{original}}",
      post_history_instructions: "",
      alternate_greetings: [],
      tags: ["通用"],
      creator: "llm-chat",
      character_version: "1.0",
      extensions: {}
    }
  };
}
export function substituteCardPlaceholders(text: string, characterName: string, userName: string): string {
  return text
    .replace(/\{\{char\}\}|<BOT>/gi, characterName)
    .replace(/\{\{user\}\}|<USER>/gi, userName);
}

function fileAssetDto(row: Row): FileAssetDto {
  const kind = row.kind as FileAssetDto["kind"];
  return {
    id: String(row.id),
    fileName: String(row.file_name),
    mimeType: String(row.mime_type),
    kind,
    byteSize: Number(row.byte_size),
    sha256: String(row.sha256),
    url: `/api/${kind === "image" ? "images" : "files"}/${String(row.id)}?v=${String(row.sha256)}`,
    createdAt: Number(row.created_at)
  };
}

function fileAssetRecord(row: Row): FileAssetRecord {
  return { ...fileAssetDto(row), storageKey: String(row.storage_key) };
}

function toolCallDto(row: Row, artifacts: FileAssetDto[] = []): ToolCallDto {
  const presentation = row.presentation_json ? parse<import("@llm-chat/contracts").ToolPresentation>(String(row.presentation_json), {}) : legacyToolPresentation(String(row.name), String(row.arguments_json), textOrNull(row.output), textOrNull(row.error));
  return {
    id: String(row.id),
    providerId: String(row.provider_id ?? row.id),
    index: Number(row.call_index),
    stepIndex: Number(row.step_index ?? Math.floor(Number(row.call_index) / 1000)),
    name: String(row.name),
    ...(presentation ? { presentation } : {}),
    arguments: String(row.arguments_json),
    approvalState: row.approval_state as ToolCallDto["approvalState"],
    requiresApproval: Boolean(row.requires_approval),
    output: textOrNull(row.output),
    error: textOrNull(row.error),
    startedAt: row.started_at === null ? null : Number(row.started_at),
    completedAt: row.completed_at === null ? null : Number(row.completed_at),
    artifacts
  };
}

function mcpServerDto(row: Row): McpServerDto {
  return {
    id: String(row.id),
    name: String(row.name),
    url: String(row.url),
    headerNames: Object.keys(parse<Record<string, string>>(row.headers_json, {})),
    enabled: Boolean(row.enabled),
    lastError: textOrNull(row.last_error),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at)
  };
}

function parseModelSettings(value: unknown): ModelSettings {
  return modelSettingsSchema.parse(parse(value, {}));
}

function parseGenerationSettings(value: unknown): GenerationSettings {
  const raw = parse<Record<string, unknown>>(value, {});
  const parsed = generationSettingsSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const defaults = modelSettingsSchema.parse(raw);
  return {
    ...defaults,
    reasoningEffort: reasoningEffortSchema.safeParse(raw.reasoningEffort).data ?? "none",
    ...(typeof raw.resolvedThinkingBudgetTokens === "number"
      ? { resolvedThinkingBudgetTokens: raw.resolvedThinkingBudgetTokens }
      : {})
  };
}

function textOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function parse<T>(value: unknown, fallback: T): T {
  try {
    return JSON.parse(String(value)) as T;
  } catch {
    return fallback;
  }
}

function titleFrom(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 60) || "新对话";
}
