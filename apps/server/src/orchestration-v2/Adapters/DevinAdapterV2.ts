import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import { resolveSelfInvocation, type SelfInvocation } from "@t3tools/shared/nodeRuntime";
import {
  defaultInstanceIdForDriver,
  DevinSettings,
  ProviderDriverKind,
  type OrchestrationV2ProviderCapabilities,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as EffectAcpErrors from "effect-acp/errors";

import * as ServerConfig from "../../config.ts";
import { makeAcpNativeLoggerFactory } from "../../provider/acp/AcpNativeLogging.ts";
import {
  normalizeAcpRegistryCommands,
  normalizeAcpRegistryLiveConfiguration,
  normalizeAcpRegistryWebUrl,
} from "../../provider/acp/AcpRegistryProbe.ts";
import * as AcpRegistryRuntimeCoordinator from "../../provider/acp/AcpRegistryRuntimeCoordinator.ts";
import * as AcpSessionRuntime from "../../provider/acp/AcpSessionRuntime.ts";
import { makeDevinAcpRuntime } from "../../provider/acp/DevinAcpSupport.ts";
import * as ProviderEventLoggers from "../../provider/Layers/ProviderEventLoggers.ts";
import { mergeProviderInstanceEnvironment } from "../../provider/ProviderInstanceEnvironment.ts";
import * as IdAllocator from "../IdAllocator.ts";
import type * as ProviderAdapter from "../ProviderAdapter.ts";
import {
  ProviderAdapterDriverCreateError,
  type ProviderAdapterDriver,
  type ProviderAdapterDriverCreateInput,
} from "../ProviderAdapterDriver.ts";
import {
  extractDevinSubagentUpdate,
  normalizeDevinSessionUpdate,
  normalizeDevinToolCall,
} from "./DevinAcp.ts";
import {
  AcpProviderCapabilitiesV2,
  makeAcpAdapterV2,
  type AcpAdapterV2Flavor,
  type AcpAdapterV2RuntimeInput,
} from "./AcpAdapterV2.ts";

export const DEVIN_PROVIDER = ProviderDriverKind.make("devin");
export const DEVIN_DEFAULT_INSTANCE_ID = defaultInstanceIdForDriver(DEVIN_PROVIDER);

const DEFAULT_DEVIN_SETTINGS = Schema.decodeSync(DevinSettings)({});

export const DevinProviderCapabilitiesV2 = {
  ...AcpProviderCapabilitiesV2,
  sessions: {
    ...AcpProviderCapabilitiesV2.sessions,
    // The `model` and `mode` session config options apply live over
    // session/set_config_option.
    supportsModelSwitchInSession: true,
    supportsRuntimeModeSwitchInSession: true,
  },
  threads: {
    ...AcpProviderCapabilitiesV2.threads,
    // Devin advertises loadSession and replays conversation history.
    canReadThreadSnapshot: true,
  },
  subagents: {
    ...AcpProviderCapabilitiesV2.subagents,
    supportsSubagents: true,
    exposesSubagentThreadIds: true,
    emitsSubagentLifecycle: true,
  },
  tools: {
    ...AcpProviderCapabilitiesV2.tools,
    supportsMcpTools: true,
  },
  checkpointing: {
    ...AcpProviderCapabilitiesV2.checkpointing,
    providerCanReadConversationSnapshot: true,
  },
} satisfies OrchestrationV2ProviderCapabilities;

export interface DevinAdapterV2Options {
  readonly instanceId: Parameters<typeof makeAcpAdapterV2>[0]["instanceId"];
  readonly settings: DevinSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly crypto: Crypto.Crypto;
  readonly selfInvocation: SelfInvocation;
  readonly fileSystem: FileSystem.FileSystem;
  readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
  readonly runtimeCoordinator?: AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator["Service"];
  readonly serverConfig: ServerConfig.ServerConfig["Service"];
  readonly nativeLogging?: Parameters<typeof makeAcpAdapterV2>[0]["nativeLogging"];
  readonly continuationRequests?: Parameters<typeof makeAcpAdapterV2>[0]["continuationRequests"];
  readonly testHooks?: Parameters<typeof makeAcpAdapterV2>[0]["testHooks"];
  readonly makeRuntime?: (
    input: AcpAdapterV2RuntimeInput,
  ) => Effect.Effect<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    EffectAcpErrors.AcpError,
    Crypto.Crypto | Scope.Scope
  >;
  readonly assertComplete?: Effect.Effect<void, EffectAcpErrors.AcpError>;
}

/**
 * Maps T3 runtime modes to Devin's native session modes
 * (`accept-edits`/`smart`/`ask`/`plan`/`bypass`). An explicit approval or
 * sandbox policy governs the thread on T3's side, so the agent must route
 * actions through `session/request_permission` for T3's disposition —
 * auto-approving session modes are off the table regardless of the stored
 * runtime mode. Plan mode is selected by the shared interaction-mode
 * machinery after this mapping.
 */
export function devinSessionModeForPolicy(
  runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy,
): string | undefined {
  if (runtimePolicy.approvalPolicy !== undefined || runtimePolicy.sandboxPolicy !== undefined) {
    return "ask";
  }
  switch (runtimePolicy.runtimeMode) {
    case "full-access":
      return "bypass";
    case "auto":
      return "smart";
    case "auto-accept-edits":
      return "accept-edits";
    case "approval-required":
      return "ask";
    default:
      return undefined;
  }
}

export function makeDevinAcpAdapterFlavor(options: DevinAdapterV2Options): AcpAdapterV2Flavor {
  const runtimeCoordinator = options.runtimeCoordinator;
  return {
    driver: DEVIN_PROVIDER,
    runtimeHarness: "Devin",
    capabilities: DevinProviderCapabilitiesV2,
    clientCapabilitiesMeta: {
      "cognition.ai/subagentSupport": true,
      "cognition.ai/messageGrouping": true,
    },
    normalizeSessionUpdate: normalizeDevinSessionUpdate,
    normalizeToolCall: normalizeDevinToolCall,
    extractSubagentUpdate: extractDevinSubagentUpdate,
    sessionModeForPolicy: devinSessionModeForPolicy,
    makeRuntime:
      options.makeRuntime ??
      ((input) =>
        makeDevinAcpRuntime({
          ...input,
          interruptPromptOnCancel: input.interruptPromptOnCancel ?? false,
          devinSettings: options.settings,
          environment: options.environment,
          childProcessSpawner: options.childProcessSpawner,
        })),
    ...(runtimeCoordinator === undefined
      ? {}
      : {
          onAvailableCommandsUpdate: (commands) =>
            runtimeCoordinator.publishAvailableCommands(
              options.instanceId,
              normalizeAcpRegistryCommands(commands),
            ),
          onSessionConfigurationUpdate: (configOptions, modeState) =>
            runtimeCoordinator.publishLiveConfiguration(
              options.instanceId,
              normalizeAcpRegistryLiveConfiguration(configOptions, modeState),
            ),
          onUrlElicitation: ({ elicitationId, url, message }) => {
            const normalizedUrl = normalizeAcpRegistryWebUrl(url);
            if (normalizedUrl === undefined || elicitationId.trim().length === 0) {
              return Effect.succeed(false);
            }
            return runtimeCoordinator.requestUrlAuthentication(options.instanceId, {
              elicitationId: elicitationId.trim().slice(0, 256),
              url: normalizedUrl,
              message: message.trim().slice(0, 1_024),
            });
          },
          withRuntimeStartup: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
            runtimeCoordinator.withForegroundStartup("devin", effect),
        }),
    ...(options.assertComplete === undefined ? {} : { assertComplete: options.assertComplete }),
  };
}

export function makeDevinAdapterV2(options: DevinAdapterV2Options) {
  const flavor = makeDevinAcpAdapterFlavor(options);
  return makeAcpAdapterV2({
    instanceId: options.instanceId,
    flavor,
    crypto: options.crypto,
    fileSystem: options.fileSystem,
    idAllocator: options.idAllocator,
    serverConfig: options.serverConfig,
    selfInvocation: options.selfInvocation,
    // Devin runs commands through client terminals and has no ask flow of its
    // own to fall back on for them.
    clientTerminals: {
      childProcessSpawner: options.childProcessSpawner,
      environment: options.environment,
      shellCommands: true,
    },
    ...(options.nativeLogging === undefined ? {} : { nativeLogging: options.nativeLogging }),
    ...(options.continuationRequests === undefined
      ? {}
      : { continuationRequests: options.continuationRequests }),
    ...(options.testHooks === undefined ? {} : { testHooks: options.testHooks }),
  });
}

export type DevinAdapterV2DriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | IdAllocator.IdAllocatorV2
  | Path.Path
  | ProviderEventLoggers.ProviderEventLoggers
  | ServerConfig.ServerConfig;

export const DevinAdapterV2Driver: ProviderAdapterDriver<DevinSettings, DevinAdapterV2DriverEnv> = {
  driverKind: DEVIN_PROVIDER,
  configSchema: DevinSettings,
  defaultConfig: (): DevinSettings => DEFAULT_DEVIN_SETTINGS,
  create: Effect.fn("DevinAdapterV2Driver.create")(
    function* (input: ProviderAdapterDriverCreateInput<DevinSettings>) {
      const hostEnvironment = yield* HostProcessEnvironment;
      const selfInvocation = yield* resolveSelfInvocation();
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const crypto = yield* Crypto.Crypto;
      const fileSystem = yield* FileSystem.FileSystem;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const providerEventLoggers = yield* ProviderEventLoggers.ProviderEventLoggers;
      const serverConfig = yield* ServerConfig.ServerConfig;
      const makeNativeLogger = yield* makeAcpNativeLoggerFactory();
      const runtimeCoordinator = yield* Effect.serviceOption(
        AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator,
      );
      return makeDevinAdapterV2({
        instanceId: input.instanceId,
        settings: { ...input.config, enabled: input.enabled },
        environment: mergeProviderInstanceEnvironment(input.environment, hostEnvironment),
        childProcessSpawner,
        crypto,
        fileSystem,
        idAllocator,
        ...(Option.isSome(runtimeCoordinator)
          ? { runtimeCoordinator: runtimeCoordinator.value }
          : {}),
        serverConfig,
        selfInvocation,
        nativeLogging: (threadId) =>
          makeNativeLogger({
            nativeEventLogger: providerEventLoggers.native,
            provider: DEVIN_PROVIDER,
            threadId,
          }),
      });
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterDriverCreateError({
              driver: DEVIN_PROVIDER,
              instanceId: input.instanceId,
              detail: "Failed to create Devin adapter.",
              cause,
            }),
        ),
      ),
  ),
};
