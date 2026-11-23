import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ManagedPolicySummary,
  type ProviderInstanceConfig,
  type ServerProvider,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { Children, mocks, commands, atoms } = vi.hoisted(() => ({
  Children: ({ children }: { children?: ReactNode }) => children,
  commands: {
    refreshProviders: { _tag: "refreshProviders" },
    mutateProviderInstance: { _tag: "mutateProviderInstance" },
    startProviderAuth: { _tag: "startProviderAuth" },
    respondProviderAuth: { _tag: "respondProviderAuth" },
    completeProviderAuth: { _tag: "completeProviderAuth" },
    cancelProviderAuth: { _tag: "cancelProviderAuth" },
    logoutProviderAuth: { _tag: "logoutProviderAuth" },
    removeProviderAuthMethod: {
      _tag: "removeProviderAuthMethod",
      permissionAtom: () => ({ _tag: "permissionAtom" }),
    },
  },
  atoms: {
    providersByEnvironmentAtom: { _tag: "providersByEnvironmentAtom" },
  },
  mocks: {
    targets: [] as ReturnType<typeof environment>[],
    providersByEnvironment: new Map<string, ReadonlyArray<ServerProvider>>(),
    readOnly: new Set<string>(),
    refreshProviders: vi.fn(),
    mutateProviderInstance: vi.fn(),
    noopCommand: vi.fn(),
    authQueryCalls: [] as Array<unknown>,
  },
}));

vi.mock("react-native", () => ({
  View: Children,
  ScrollView: Children,
  TextInput: () => null,
  Alert: { alert: vi.fn() },
  useWindowDimensions: () => ({ width: 390, height: 844 }),
  Pressable: ({
    children,
    disabled,
    onPress,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    disabled?: boolean;
    onPress?: () => void;
    accessibilityLabel?: string;
  }) => (
    <button type="button" disabled={disabled} onClick={onPress} aria-label={accessibilityLabel}>
      {children}
    </button>
  ),
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: unknown) =>
    atom === atoms.providersByEnvironmentAtom ? mocks.providersByEnvironment : true,
}));
vi.mock("../../state/presentation", () => ({
  environmentPresentations: {
    providersByEnvironmentAtom: atoms.providersByEnvironmentAtom,
  },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (atom: unknown) => {
    mocks.authQueryCalls.push(atom);
    return { status: "idle", value: undefined, refresh: vi.fn() };
  },
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    ...commands,
    providerAuthState: (target: unknown) => ({ _tag: "providerAuthState", target }),
  },
}));
vi.mock("../../state/session", () => ({
  useEnvironmentsWithScope: () =>
    new Set(
      mocks.targets
        .map((target) => target.environmentId)
        .filter((environmentId) => !mocks.readOnly.has(environmentId)),
    ),
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) => {
    if (command === commands.refreshProviders) return mocks.refreshProviders;
    if (command === commands.mutateProviderInstance) return mocks.mutateProviderInstance;
    return mocks.noopCommand;
  },
}));
vi.mock("../../lib/openExternalUrl", () => ({ tryOpenExternalUrl: vi.fn() }));
vi.mock("../../components/ui/AppActivityIndicator", () => ({ AppActivityIndicator: () => null }));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({
    children,
    accessibilityRole,
  }: {
    children?: ReactNode;
    accessibilityRole?: string;
  }) => <span role={accessibilityRole}>{children}</span>,
}));
vi.mock("../../components/ui/Button", () => ({
  Button: ({
    label,
    disabled,
    onPress,
  }: {
    label: string;
    disabled?: boolean;
    onPress?: () => void;
  }) => (
    <button type="button" disabled={disabled} onClick={onPress}>
      {label}
    </button>
  ),
}));
vi.mock("../../components/ui/ControlPill", () => ({
  ControlPill: ({
    label,
    accessibilityLabel,
    disabled,
    onPress,
  }: {
    label?: string;
    accessibilityLabel?: string;
    disabled?: boolean;
    onPress?: () => void;
  }) => (
    <button type="button" disabled={disabled} onClick={onPress} aria-label={accessibilityLabel}>
      {label}
    </button>
  ),
}));
vi.mock("../../components/ui/Dialog", () => ({
  Root: () => null,
  Header: Children,
  Title: Children,
  Description: Children,
  Footer: Children,
}));
vi.mock("../../components/ui/ListActionRow", () => ({
  ListActionRow: ({
    label,
    disabled,
    loading,
    onPress,
  }: {
    label: string;
    disabled?: boolean;
    loading?: boolean;
    onPress: () => void;
  }) => (
    <button
      type="button"
      disabled={Boolean(disabled || loading)}
      aria-busy={Boolean(loading)}
      onClick={onPress}
    >
      {label}
    </button>
  ),
}));
vi.mock("../../components/ui/Menu", () => ({ Menu: Children }));
vi.mock("../../components/ui/ScreenScrollView", () => ({ ScreenScrollView: Children }));
vi.mock("../../components/ui/ThemedSwitch", () => ({
  ThemedSwitch: ({
    value,
    disabled,
    accessibilityLabel,
    onValueChange,
  }: {
    value: boolean;
    disabled?: boolean;
    accessibilityLabel?: string;
    onValueChange: (next: boolean) => void;
  }) => (
    <button
      type="button"
      role="switch"
      aria-checked={value}
      aria-label={accessibilityLabel}
      disabled={disabled}
      onClick={() => onValueChange(!value)}
    >
      {accessibilityLabel}
    </button>
  ),
}));
vi.mock("./components/SettingsEnvironmentFilterHeader", () => ({
  useSettingsEnvironmentMenu: () => ({
    title: "Filter",
    icon: "line.3.horizontal.decrease.circle",
    items: [],
  }),
}));
vi.mock("./components/SettingsScreen", () => ({ SettingsScreen: Children }));
vi.mock("./components/SettingsSection", () => ({ SettingsSection: Children }));
vi.mock("./settings-environment-filter", () => ({
  useSettingsEnvironmentFilter: () => ({
    selectedTargets: mocks.targets,
  }),
}));

import { SettingsProviderAccountsRouteScreen } from "./SettingsProviderAccountsRouteScreen";

function environment(
  environmentId: string,
  label: string,
  options?: {
    managedPolicy?: ManagedPolicySummary;
    providerInstances?: Record<string, ProviderInstanceConfig>;
  },
) {
  return {
    environmentId,
    label,
    connection: { phase: "connected" },
    serverConfig: {
      managedPolicy: options?.managedPolicy,
      settings: {
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances: options?.providerInstances ?? {},
      },
    },
  };
}

function makeProvider(
  overrides: Omit<Partial<ServerProvider>, "instanceId" | "driver"> & {
    instanceId: string;
    driver: string;
  },
): ServerProvider {
  return {
    displayName: overrides.displayName ?? overrides.instanceId,
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "unknown" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
    instanceId: ProviderInstanceId.make(overrides.instanceId),
    driver: ProviderDriverKind.make(overrides.driver),
  };
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  root = createRoot(container);
  mocks.targets = [environment("local", "Local")];
  mocks.providersByEnvironment = new Map();
  mocks.readOnly = new Set();
  mocks.refreshProviders.mockReset();
  mocks.refreshProviders.mockResolvedValue(AsyncResult.success(undefined));
  mocks.mutateProviderInstance.mockReset();
  mocks.mutateProviderInstance.mockResolvedValue(AsyncResult.success(undefined));
  mocks.noopCommand.mockReset();
  mocks.authQueryCalls = [];
});

afterEach(() => {
  act(() => root.unmount());
});

describe("SettingsProviderAccountsRouteScreen", () => {
  it("renders all managed-allowed providers with live status without filtering out non-auth providers", () => {
    mocks.targets = [
      environment("local", "Local", {
        managedPolicy: {
          organization: "Acme",
          lockedSettings: [],
          limits: {
            providers: {
              allowedDrivers: [
                ProviderDriverKind.make("codex"),
                ProviderDriverKind.make("cursor"),
                ProviderDriverKind.make("claudeAgent"),
              ],
            },
          },
        },
      }),
    ];
    mocks.providersByEnvironment = new Map([
      [
        "local",
        [
          makeProvider({
            instanceId: "codex",
            driver: "codex",
            displayName: "Codex",
            enabled: true,
            installed: true,
            status: "ready",
          }),
          makeProvider({
            instanceId: "cursor",
            driver: "cursor",
            displayName: "Cursor",
            enabled: false,
            installed: false,
            status: "disabled",
            setup: { canAuthenticate: true, canInstall: false },
          }),
          makeProvider({
            instanceId: "grok",
            driver: "grok",
            displayName: "Grok",
            enabled: false,
            installed: false,
            status: "disabled",
          }),
          makeProvider({
            instanceId: "claudeAgent",
            driver: "claudeAgent",
            displayName: "Claude",
            enabled: true,
            installed: false,
            status: "error",
          }),
        ],
      ],
    ]);

    act(() => root.render(<SettingsProviderAccountsRouteScreen />));

    expect(container.textContent).toContain("Codex");
    expect(container.textContent).toContain("Ready");
    expect(container.textContent).toContain("Cursor");
    expect(container.textContent).toContain("Turned off");
    expect(container.textContent).toContain("Claude");
    expect(container.textContent).toContain("Not installed");
    expect(container.textContent).not.toContain("Grok");
    // Only auth-capable providers subscribe to providerAuthState
    expect(mocks.authQueryCalls.filter(Boolean)).toHaveLength(1);
  });

  it("toggles provider instances via mutateProviderInstance while preserving existing config", async () => {
    mocks.targets = [
      environment("local", "Local", {
        providerInstances: {
          codex: {
            driver: ProviderDriverKind.make("codex"),
            displayName: "Codex",
            enabled: true,
            config: { customFlag: true },
          },
          claudeAgent: {
            driver: ProviderDriverKind.make("claudeAgent"),
            displayName: "Claude Work",
            enabled: true,
            config: { configDir: "/tmp/claude-work" },
          },
        },
      }),
    ];
    mocks.providersByEnvironment = new Map([
      [
        "local",
        [
          makeProvider({
            instanceId: "codex",
            driver: "codex",
            displayName: "Codex",
            enabled: true,
          }),
          makeProvider({
            instanceId: "claudeAgent",
            driver: "claudeAgent",
            displayName: "Claude Work",
            enabled: true,
          }),
        ],
      ],
    ]);

    act(() => root.render(<SettingsProviderAccountsRouteScreen />));

    const codexSwitch = container.querySelector<HTMLButtonElement>(
      'button[role="switch"][aria-label="Enable Codex"]',
    );
    const claudeSwitch = container.querySelector<HTMLButtonElement>(
      'button[role="switch"][aria-label="Enable Claude Work"]',
    );
    expect(codexSwitch).not.toBeNull();
    expect(claudeSwitch).not.toBeNull();

    await act(async () => {
      codexSwitch!.click();
    });
    expect(mocks.mutateProviderInstance).toHaveBeenCalledWith({
      environmentId: "local",
      input: {
        patch: {},
        providerInstanceMutation: {
          operation: "upsert",
          instanceId: "codex",
          instance: {
            driver: "codex",
            displayName: "Codex",
            enabled: false,
            config: { customFlag: true },
          },
        },
      },
    });

    await act(async () => {
      claudeSwitch!.click();
    });
    expect(mocks.mutateProviderInstance).toHaveBeenLastCalledWith({
      environmentId: "local",
      input: {
        patch: {},
        providerInstanceMutation: {
          operation: "upsert",
          instanceId: "claudeAgent",
          instance: {
            driver: "claudeAgent",
            displayName: "Claude Work",
            enabled: false,
            config: { configDir: "/tmp/claude-work" },
          },
        },
      },
    });
  });

  it("disables switches locked by managed policy", () => {
    mocks.targets = [
      environment("local", "Local", {
        managedPolicy: {
          organization: "Acme",
          lockedSettings: ["providerInstances.codex.enabled", "providerInstances.claudeAgent"],
        },
      }),
    ];
    mocks.providersByEnvironment = new Map([
      [
        "local",
        [
          makeProvider({
            instanceId: "codex",
            driver: "codex",
            displayName: "Codex",
            enabled: true,
          }),
          makeProvider({
            instanceId: "claudeAgent",
            driver: "claudeAgent",
            displayName: "Claude",
            enabled: true,
          }),
        ],
      ],
    ]);

    act(() => root.render(<SettingsProviderAccountsRouteScreen />));

    const codexSwitch = container.querySelector<HTMLButtonElement>(
      'button[role="switch"][aria-label="Enable Codex"]',
    );
    const claudeSwitch = container.querySelector<HTMLButtonElement>(
      'button[role="switch"][aria-label="Enable Claude"]',
    );
    expect(codexSwitch?.disabled).toBe(true);
    expect(claudeSwitch?.disabled).toBe(true);
  });

  it("refreshes providers via serverEnvironment.refreshProviders and surfaces errors", async () => {
    mocks.providersByEnvironment = new Map([
      [
        "local",
        [
          makeProvider({
            instanceId: "codex",
            driver: "codex",
            displayName: "Codex",
          }),
        ],
      ],
    ]);

    act(() => root.render(<SettingsProviderAccountsRouteScreen />));

    const refreshButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Refresh providers",
    );
    expect(refreshButton).toBeDefined();

    await act(async () => {
      refreshButton!.click();
    });
    expect(mocks.refreshProviders).toHaveBeenCalledWith({
      environmentId: "local",
      input: { reloadSecrets: true },
    });

    mocks.refreshProviders.mockResolvedValueOnce(AsyncResult.fail(new Error("Server unreachable")));
    await act(async () => {
      refreshButton!.click();
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Server unreachable");
  });

  it("respects AuthProvidersManageScope by hiding controls for read-only environments", () => {
    mocks.readOnly = new Set(["local"]);
    mocks.providersByEnvironment = new Map([
      [
        "local",
        [
          makeProvider({
            instanceId: "codex",
            driver: "codex",
            displayName: "Codex",
          }),
        ],
      ],
    ]);

    act(() => root.render(<SettingsProviderAccountsRouteScreen />));

    expect(container.textContent).toContain("Limited permissions");
    expect(container.querySelector('button[role="switch"]')).toBeNull();
    expect(container.textContent).not.toContain("Refresh providers");
  });
});
