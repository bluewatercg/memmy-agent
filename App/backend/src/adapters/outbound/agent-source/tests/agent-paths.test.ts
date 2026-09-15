import { join, normalize } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  resolveClaudeCodeHomeDirectory,
  resolveClaudeCodeProjectsDirectory,
  resolveCodexHomeDirectory,
  resolveCodexSessionsDirectory,
  resolveCursorDataPaths,
  resolveFreebuffHomeDirectory,
  resolveDeepseekHarnessHomeDirectory,
  resolveDeepseekHarnessSessionsDirectory,
  resolveHermesHomeDirectory,
  resolveOmpHomeDirectory,
  resolveOmpSessionsDirectory,
  resolveOpencodeConfigDirectory,
  resolveOpencodeDataDirectory,
  resolveOpencodeDatabasePath,
  resolveOpenclawConfigPath,
  resolveOpenclawStateDirectory,
  resolvePiAgentDirectory,
  resolvePiSessionsDirectory,
  resolveQwenworkHomeDirectory,
  resolveQwenworkProjectsDirectory,
  resolveWorkbuddyHomeDirectory,
  resolveWorkbuddyProjectsDirectory
} from "../../agent-paths.js";

const ENVIRONMENT_VARIABLES = [
  "APPDATA",
  "CLAUDE_CONFIG_DIR",
  "CODEBUDDY_CONFIG_DIR",
  "CODEX_HOME",
  "FREEBUFF_CONFIG_DIR",
  "DSH_HOME",
  "HERMES_HOME",
  "OPENCODE_CONFIG_DIR",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_STATE_DIR",
  "PI_CODING_AGENT_DIR",
  "PI_CODING_AGENT_SESSION_DIR",
  "QWENWORK_CONFIG_DIR",
  "WORKBUDDY_CONFIG_DIR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME"
] as const;
const originalEnvironment = new Map(ENVIRONMENT_VARIABLES.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const [key, value] of originalEnvironment) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe("agent paths", () => {
  it("honors each Agent's configured home or state directory", () => {
    process.env.CLAUDE_CONFIG_DIR = "/tmp/claude-home";
    process.env.CODEX_HOME = "/tmp/codex-home";
    process.env.DSH_HOME = "/tmp/dsh-home";
    process.env.HERMES_HOME = "/tmp/hermes-home";
    process.env.OPENCLAW_STATE_DIR = "/tmp/openclaw-state";
    process.env.OPENCLAW_CONFIG_PATH = "/tmp/openclaw-config.json";
    process.env.PI_CODING_AGENT_DIR = "/tmp/omp-home";
    process.env.PI_CODING_AGENT_SESSION_DIR = "/tmp/omp-sessions";
    process.env.FREEBUFF_CONFIG_DIR = "/tmp/freebuff-home";
    process.env.WORKBUDDY_CONFIG_DIR = "/tmp/workbuddy-home";

    expect(resolveClaudeCodeHomeDirectory()).toBe("/tmp/claude-home");
    expect(resolveCodexHomeDirectory()).toBe("/tmp/codex-home");
    expect(resolveHermesHomeDirectory()).toBe("/tmp/hermes-home");
    expect(resolveOpenclawStateDirectory()).toBe("/tmp/openclaw-state");
    expect(resolveOpenclawConfigPath()).toBe("/tmp/openclaw-config.json");
    expect(resolveOmpHomeDirectory()).toBe("/tmp/omp-home");
    expect(resolveOmpSessionsDirectory()).toBe("/tmp/omp-sessions");
    expect(resolveFreebuffHomeDirectory()).toBe("/tmp/freebuff-home");
    expect(resolveWorkbuddyHomeDirectory()).toBe("/tmp/workbuddy-home");
    process.env.PI_CODING_AGENT_DIR = "/tmp/pi-agent";
    process.env.QWENWORK_CONFIG_DIR = "/tmp/qwenwork-home";
    process.env.WORKBUDDY_CONFIG_DIR = "/tmp/workbuddy-home";

    expect(resolveClaudeCodeHomeDirectory()).toBe(normalize("/tmp/claude-home"));
    expect(resolveCodexHomeDirectory()).toBe(normalize("/tmp/codex-home"));
    expect(resolveDeepseekHarnessHomeDirectory()).toBe(normalize("/tmp/dsh-home"));
    expect(resolveDeepseekHarnessSessionsDirectory()).toBe(join(normalize("/tmp/dsh-home"), "sessions"));
    expect(resolveHermesHomeDirectory()).toBe(normalize("/tmp/hermes-home"));
    expect(resolveOpenclawStateDirectory()).toBe(normalize("/tmp/openclaw-state"));
    expect(resolveOpenclawConfigPath()).toBe(normalize("/tmp/openclaw-config.json"));
    expect(resolvePiAgentDirectory()).toBe(normalize("/tmp/pi-agent"));
    expect(resolveQwenworkHomeDirectory()).toBe(normalize("/tmp/qwenwork-home"));
    expect(resolveWorkbuddyHomeDirectory()).toBe(normalize("/tmp/workbuddy-home"));
  });

  it("uses WorkBuddy's official config directory variables", () => {
    process.env.WORKBUDDY_CONFIG_DIR = "/tmp/workbuddy-current";
    process.env.CODEBUDDY_CONFIG_DIR = "/tmp/workbuddy-legacy-product-name";

    expect(resolveWorkbuddyHomeDirectory()).toBe(normalize("/tmp/workbuddy-current"));

    process.env.WORKBUDDY_CONFIG_DIR = " ";
    expect(resolveWorkbuddyHomeDirectory()).toBe(normalize("/tmp/workbuddy-legacy-product-name"));
  });

  it("uses OpenCode's custom config directory and XDG data directory", () => {
    process.env.XDG_CONFIG_HOME = "/tmp/xdg-config";
    process.env.XDG_DATA_HOME = "/tmp/xdg-data";
    delete process.env.OPENCODE_CONFIG_DIR;

    expect(resolveOpencodeConfigDirectory()).toBe(join("/tmp/xdg-config", "opencode"));
    expect(resolveOpencodeDataDirectory()).toBe(join("/tmp/xdg-data", "opencode"));

    process.env.OPENCODE_CONFIG_DIR = "/tmp/custom-opencode";
    expect(resolveOpencodeConfigDirectory()).toBe(normalize("/tmp/custom-opencode"));
  });

  it("resolves all Agent source paths on macOS", () => {
    const options = {
      platform: "darwin" as const,
      homeDirectory: "/Users/alice",
      environment: {}
    };

    expect({
      cursor: resolveCursorDataPaths(options).workspaceStorageDirectory,
      claudeCode: resolveClaudeCodeProjectsDirectory(options),
      codex: resolveCodexSessionsDirectory(options),
      opencode: resolveOpencodeDatabasePath(options),
      openclaw: resolveOpenclawStateDirectory(options),
      omp: resolveOmpSessionsDirectory(options),
      hermes: resolveHermesHomeDirectory(options),
      freebuff: resolveFreebuffHomeDirectory(options)
      deepseekHarness: resolveDeepseekHarnessSessionsDirectory(options),
      pi: resolvePiSessionsDirectory(options),
      qwenwork: resolveQwenworkProjectsDirectory(options),
      workbuddy: resolveWorkbuddyProjectsDirectory(options)
    }).toEqual({
      cursor: "/Users/alice/Library/Application Support/Cursor/User/workspaceStorage",
      claudeCode: "/Users/alice/.claude/projects",
      codex: "/Users/alice/.codex/sessions",
      opencode: "/Users/alice/.local/share/opencode/opencode.db",
      openclaw: "/Users/alice/.openclaw",
      omp: "/Users/alice/.pi/agent/sessions",
      hermes: "/Users/alice/.hermes",
      freebuff: "/Users/alice/.config/manicode"
    });
  });

  it("resolves all nine Agent source paths on Windows", () => {
      deepseekHarness: "/Users/alice/.dsh/sessions",
      pi: "/Users/alice/.pi/agent/sessions",
      qwenwork: "/Users/alice/.qwenworkcn/projects",
      workbuddy: "/Users/alice/.workbuddy/projects"
    });
  });

  it("resolves all Agent source paths on Windows", () => {
    const options = {
      platform: "win32",
      homeDirectory: "C:\\Users\\alice",
      environment: {
        APPDATA: "C:\\Users\\alice\\AppData\\Roaming"
      }
    } as const;

    expect({
      cursor: resolveCursorDataPaths(options).workspaceStorageDirectory,
      claudeCode: resolveClaudeCodeProjectsDirectory(options),
      codex: resolveCodexSessionsDirectory(options),
      opencode: resolveOpencodeDatabasePath(options),
      openclaw: resolveOpenclawStateDirectory(options),
      omp: resolveOmpSessionsDirectory(options),
      hermes: resolveHermesHomeDirectory(options),
      freebuff: resolveFreebuffHomeDirectory(options)
      deepseekHarness: resolveDeepseekHarnessSessionsDirectory(options),
      pi: resolvePiSessionsDirectory(options),
      qwenwork: resolveQwenworkProjectsDirectory(options),
      workbuddy: resolveWorkbuddyProjectsDirectory(options)
    }).toEqual({
      cursor: "C:\\Users\\alice\\AppData\\Roaming\\Cursor\\User\\workspaceStorage",
      claudeCode: "C:\\Users\\alice\\.claude\\projects",
      codex: "C:\\Users\\alice\\.codex\\sessions",
      opencode: "C:\\Users\\alice\\.local\\share\\opencode\\opencode.db",
      openclaw: "C:\\Users\\alice\\.openclaw",
      omp: "C:\\Users\\alice\\.pi\\agent\\sessions",
      hermes: "C:\\Users\\alice\\.hermes",
      freebuff: "C:\\Users\\alice\\.config\\manicode"
      deepseekHarness: "C:\\Users\\alice\\.dsh\\sessions",
      pi: "C:\\Users\\alice\\.pi\\agent\\sessions",
      qwenwork: "C:\\Users\\alice\\.qwenworkcn\\projects",
      workbuddy: "C:\\Users\\alice\\.workbuddy\\projects"
    });
  });

  it("resolves Cursor's Linux XDG path and Windows fallback path", () => {
    expect(resolveCursorDataPaths({
      platform: "linux",
      homeDirectory: "/home/alice",
      environment: {
        XDG_CONFIG_HOME: "/srv/alice/config"
      }
    }).userDirectory).toBe("/srv/alice/config/Cursor/User");

    expect(resolveCursorDataPaths({
      platform: "win32",
      homeDirectory: "C:\\Users\\alice",
      environment: {}
    }).userDirectory).toBe("C:\\Users\\alice\\AppData\\Roaming\\Cursor\\User");
  });
});
