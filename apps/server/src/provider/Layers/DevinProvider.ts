import {
  type CustomModelSetting,
  type DevinSettings,
  officialAcpRegistryIconUrlForAgentId,
  type ProviderInstanceId,
  ProviderDriverKind,
  type RuntimeMode,
  type ServerProvider,
  type ServerProviderAuth,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  AUTH_PROBE_TIMEOUT_MS,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
} from "../providerSnapshot.ts";
import type { AcpRegistryConfigurationProbeResult } from "../acp/AcpRegistryProbe.ts";
import type { AcpRegistryOperationError } from "@t3tools/contracts";
import { DEVIN_ACP_AGENT_ID } from "../acp/DevinAcpSupport.ts";

export const DEVIN_DRIVER_KIND = ProviderDriverKind.make("devin");

export const DEVIN_SUPPORTED_RUNTIME_MODES = [
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
] as const satisfies ReadonlyArray<RuntimeMode>;

const DEVIN_PRESENTATION = {
  displayName: "Devin",
  supportsConversationRollback: false,
  showInteractionModeToggle: true,
  supportedRuntimeModes: DEVIN_SUPPORTED_RUNTIME_MODES,
} as const;

const VERSION_PROBE_TIMEOUT_MS = 4_000;
const EMPTY_CAPABILITIES = createModelCapabilities({ optionDescriptors: [] });

interface DevinSnapshotIdentity {
  readonly instanceId: ProviderInstanceId;
  readonly displayName: string | undefined;
  readonly accentColor: string | undefined;
  readonly continuationKey: string;
}

const DEVIN_FALLBACK_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "default",
    name: "Devin default",
    isCustom: false,
    isDefault: true,
    capabilities: EMPTY_CAPABILITIES,
  },
];

/**
 * Models advertised by the live session's `model` config option, with the
 * session's non-model options (mode, thought level) riding on every entry so
 * the composer can drive them per thread.
 */
export function buildDevinModelsFromProbe(
  probe: AcpRegistryConfigurationProbeResult["probe"] | undefined,
  customModels: ReadonlyArray<CustomModelSetting> | undefined,
): ReadonlyArray<ServerProviderModel> {
  const capabilities =
    probe === undefined || probe.configOptions.length === 0
      ? EMPTY_CAPABILITIES
      : createModelCapabilities({ optionDescriptors: probe.configOptions });
  const probeModels = probe?.models ?? [];
  const currentModelId = probe?.currentModelId;
  const builtInModels: ReadonlyArray<ServerProviderModel> =
    probeModels.length === 0
      ? DEVIN_FALLBACK_MODELS.map((model) => ({ ...model, capabilities }))
      : probeModels.map((model) => ({
          slug: model.id,
          name: model.name,
          isCustom: false,
          ...(model.id === currentModelId ? { isDefault: true } : {}),
          capabilities,
        }));
  return providerModelsFromSettings(builtInModels, customModels ?? [], capabilities);
}

export interface DevinAuthStatusOutput {
  readonly status: ServerProviderAuth["status"];
  readonly email: string | undefined;
}

/**
 * Parses `devin auth status`. A signed-in CLI starts with `Logged in (via …)`
 * and carries an `Email:` field; a signed-out CLI says it is not logged in.
 * Anything else stays unknown.
 */
export function parseDevinAuthStatusOutput(output: string): DevinAuthStatusOutput {
  if (/^\s*Logged in\b/im.test(output)) {
    const email = output.match(/^\s*Email:\s*(\S+)\s*$/m)?.[1];
    return { status: "authenticated", email };
  }
  if (/not logged in|no credentials|not authenticated/i.test(output)) {
    return { status: "unauthenticated", email: undefined };
  }
  return { status: "unknown", email: undefined };
}

const runDevinCliCommand = (
  devinSettings: DevinSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    const command = devinSettings.binaryPath || "devin";
    const spawnCommand = yield* resolveSpawnCommand(command, args, { env: environment });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  });

export function buildDevinBaseSnapshot(
  input: DevinSnapshotIdentity & {
    readonly settings: DevinSettings;
    readonly checkedAt: string;
    readonly installed: boolean;
    readonly version: string | null;
    readonly status: ServerProvider["status"];
    readonly auth: ServerProviderAuth;
    readonly message?: string;
    readonly probe?: AcpRegistryConfigurationProbeResult;
  },
): ServerProvider {
  const iconUrl = officialAcpRegistryIconUrlForAgentId(DEVIN_ACP_AGENT_ID);
  // Cloud threads run in Devin Cloud, but the session list lives in the local
  // agent's database, so listing and deleting are offered only for the local
  // transport.
  const cloudTransport = input.settings.cloud === true;
  return {
    instanceId: input.instanceId,
    driver: DEVIN_DRIVER_KIND,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    ...(iconUrl ? { iconUrl } : {}),
    continuation: { groupKey: input.continuationKey },
    // Devin sessions are agent-side compute; T3 does not offer them for
    // commit/PR/title text generation.
    supportsTextGeneration: false,
    ...DEVIN_PRESENTATION,
    enabled: input.settings.enabled,
    installed: input.installed,
    version: input.version,
    status: input.settings.enabled ? input.status : "disabled",
    auth: {
      ...input.auth,
      canLogout:
        input.auth.canLogout ??
        input.probe?.probe.sessionManagement.canLogout ??
        input.auth.status === "authenticated",
    },
    checkedAt: input.checkedAt,
    setup: {
      canInstall: false,
      canAuthenticate:
        input.installed && (input.probe ? input.probe.probe.authMethods.length > 0 : true),
    },
    ...(input.message ? { message: input.message } : {}),
    models: buildDevinModelsFromProbe(input.probe?.probe, input.settings.customModels),
    ...(input.probe === undefined
      ? {}
      : {
          nativeSessions: {
            canList: input.probe.probe.sessionManagement.canList && !cloudTransport,
            canLoad: input.probe.probe.sessionManagement.canLoad,
            canResume: input.probe.probe.sessionManagement.canResume,
            canDelete: input.probe.probe.sessionManagement.canDelete && !cloudTransport,
          },
          configurableProviders: input.probe.probe.sessionManagement.canConfigureProviders,
        }),
    slashCommands: input.probe?.slashCommands ?? [],
    skills: input.probe?.skills ?? [],
  };
}

export const buildInitialDevinProviderSnapshot = (
  input: DevinSnapshotIdentity & { readonly settings: DevinSettings },
): Effect.Effect<ServerProvider> =>
  Effect.gen(function* () {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    if (!input.settings.enabled) {
      return buildDevinBaseSnapshot({
        ...input,
        checkedAt,
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Devin is disabled in T3 Code settings.",
      });
    }
    return buildDevinBaseSnapshot({
      ...input,
      checkedAt,
      installed: true,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: "Checking Devin CLI availability...",
    });
  });

/** `devin --version` plus `devin auth status`: fast readiness without starting an ACP process. */
export const checkDevinProviderReadiness = Effect.fn("DevinProvider.checkProviderReadiness")(
  function* (
    input: DevinSnapshotIdentity & {
      readonly settings: DevinSettings;
      readonly environment: NodeJS.ProcessEnv;
    },
  ): Effect.fn.Return<ServerProvider, never, ChildProcessSpawner.ChildProcessSpawner> {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    if (!input.settings.enabled) {
      return yield* buildInitialDevinProviderSnapshot(input);
    }

    const versionResult = yield* runDevinCliCommand(
      input.settings,
      ["--version"],
      input.environment,
    ).pipe(Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS), Effect.result);

    if (Result.isFailure(versionResult)) {
      const error = versionResult.failure;
      yield* Effect.logWarning("Devin CLI health check failed.", { errorTag: error._tag });
      return buildDevinBaseSnapshot({
        ...input,
        checkedAt,
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "Devin CLI (`devin`) is not installed or not on PATH."
          : "Failed to execute Devin CLI health check.",
      });
    }

    if (Option.isNone(versionResult.success)) {
      return buildDevinBaseSnapshot({
        ...input,
        checkedAt,
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Devin CLI is installed but timed out while running `devin --version`.",
      });
    }

    const versionOutput = versionResult.success.value;
    const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
    if (versionOutput.code !== 0) {
      yield* Effect.logWarning("Devin CLI version probe exited with a non-zero status.", {
        exitCode: versionOutput.code,
      });
      return buildDevinBaseSnapshot({
        ...input,
        checkedAt,
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Devin CLI is installed but failed to run.",
      });
    }

    const authResult = yield* runDevinCliCommand(
      input.settings,
      ["auth", "status"],
      input.environment,
    ).pipe(Effect.timeoutOption(AUTH_PROBE_TIMEOUT_MS), Effect.result);
    const authOutput =
      Result.isSuccess(authResult) && Option.isSome(authResult.success)
        ? authResult.success.value
        : undefined;
    const parsedAuth =
      authOutput === undefined || authOutput.code !== 0
        ? ({ status: "unknown", email: undefined } as const)
        : parseDevinAuthStatusOutput(`${authOutput.stdout}\n${authOutput.stderr}`);
    const auth: ServerProviderAuth =
      parsedAuth.status === "authenticated"
        ? {
            status: "authenticated",
            type: "account",
            label: "Devin account",
            ...(parsedAuth.email ? { email: parsedAuth.email } : {}),
          }
        : parsedAuth.status === "unauthenticated"
          ? { status: "unauthenticated" }
          : { status: "unknown" };

    if (parsedAuth.status === "unauthenticated") {
      return buildDevinBaseSnapshot({
        ...input,
        checkedAt,
        installed: true,
        version,
        status: "error",
        auth,
        message: "Devin CLI is installed but not signed in. Sign in to continue.",
      });
    }

    return buildDevinBaseSnapshot({
      ...input,
      checkedAt,
      installed: true,
      version,
      status: "ready",
      auth,
      message:
        parsedAuth.status === "unknown"
          ? "Devin CLI is installed. Sign-in status could not be verified."
          : "Checking Devin authentication, models, and commands in the background...",
    });
  },
);

/**
 * Compose the fast readiness check with the disposable ACP configuration
 * probe (models, session config options, session management, commands).
 * The probe effect is injected so tests can substitute a stub.
 */
export const checkDevinProviderStatus = Effect.fn("DevinProvider.checkProviderStatus")(function* <
  R,
>(
  input: DevinSnapshotIdentity & {
    readonly settings: DevinSettings;
    readonly environment: NodeJS.ProcessEnv;
  },
  probe: () => Effect.Effect<AcpRegistryConfigurationProbeResult, AcpRegistryOperationError, R>,
): Effect.fn.Return<ServerProvider, never, ChildProcessSpawner.ChildProcessSpawner | R> {
  const readiness = yield* checkDevinProviderReadiness(input);
  if (!readiness.installed || readiness.status === "disabled") {
    return readiness;
  }
  const probed = yield* probe().pipe(Effect.result);
  if (Result.isFailure(probed)) {
    return {
      ...readiness,
      status: readiness.auth.status === "unauthenticated" ? readiness.status : "warning",
      ...(readiness.auth.status === "unauthenticated"
        ? {}
        : {
            message:
              "Devin CLI is installed but the ACP configuration probe failed. Model options may be incomplete.",
          }),
    };
  }
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  return buildDevinBaseSnapshot({
    ...input,
    checkedAt,
    installed: readiness.installed,
    version: readiness.version,
    status: "ready",
    auth: readiness.auth,
    probe: probed.success,
  });
});
