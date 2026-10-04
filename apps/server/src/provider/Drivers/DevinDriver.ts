import {
  DevinSettings,
  type CustomModelSetting,
  type ServerProvider,
  TextGenerationError,
} from "@t3tools/contracts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import * as ServerConfig from "../../config.ts";
import {
  DevinAdapterV2Driver,
  type DevinAdapterV2DriverEnv,
} from "../../orchestration-v2/Adapters/DevinAdapterV2.ts";
import * as ServerSettings from "../../serverSettings.ts";
import type { TextGeneration } from "../../textGeneration/TextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import {
  buildInitialDevinProviderSnapshot,
  checkDevinProviderReadiness,
  checkDevinProviderStatus,
  DEVIN_DRIVER_KIND,
} from "../Layers/DevinProvider.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  makeCachedProviderMaintenanceResolution,
  makeManualOnlyProviderMaintenanceCapabilities,
  makeProviderMaintenanceCapabilities,
  type ProviderMaintenanceCapabilitiesResolver,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "../providerMaintenance.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";
import {
  deleteAcpRegistrySession,
  disableAcpRegistryProvider,
  listAcpRegistryProviders,
  listAcpRegistrySessions,
  logoutAcpRegistry,
  probeAcpRegistryConfiguration,
  setAcpRegistryProvider,
} from "../acp/AcpRegistryProbe.ts";
import * as AcpRegistrySupport from "../acp/AcpRegistrySupport.ts";
import * as AcpRegistryRuntimeCoordinator from "../acp/AcpRegistryRuntimeCoordinator.ts";
import * as AcpRegistryAuth from "../acp/AcpRegistryAuth.ts";
import * as AcpRegistryAuthenticationState from "../acp/AcpRegistryAuthenticationState.ts";
import { devinAcpRegistrySettings } from "../acp/DevinAcpSupport.ts";
import {
  applyAcpRegistryAvailableCommands,
  applyAcpRegistryLiveConfiguration,
  applyAcpRegistryUrlAuthAction,
} from "./AcpRegistryDriver.ts";

const decodeDevinSettings = Schema.decodeSync(DevinSettings);
// How long a successful configuration probe stays valid. Periodic health
// refreshes reuse it instead of spawning a fresh disposable ACP session;
// failed or unauthenticated probes are never cached so a completed sign-in
// is detected on the next refresh.
const PROBE_SUCCESS_TTL_MS = 15 * 60 * 1_000;
// `devin update` finds and replaces the install that owns the resolved
// executable itself, so the binary is its own updater. The CLI is distributed
// through Cognition's installer (no npm channel), so there is no registry
// "latest" feed to compare against — the updater detects staleness itself.
const UPDATE: ProviderMaintenanceCapabilitiesResolver = {
  resolve: (context) =>
    Effect.succeed(
      context
        ? makeProviderMaintenanceCapabilities({
            provider: DEVIN_DRIVER_KIND,
            packageName: null,
            updateExecutable: context.resolvedCommandPath,
            updateArgs: ["update"],
            updateLockKey: "devin",
            platform: context.platform,
            env: context.env,
            latestVersion: null,
          })
        : makeManualOnlyProviderMaintenanceCapabilities({
            provider: DEVIN_DRIVER_KIND,
            packageName: null,
          }),
    ),
};

const makeUnsupportedTextGeneration = (): TextGeneration["Service"] => {
  const unsupported = (operation: string) =>
    Effect.fail(
      new TextGenerationError({
        operation,
        detail: "Devin instances do not provide application text generation.",
      }),
    );
  return {
    generateCommitMessage: () => unsupported("generateCommitMessage"),
    generatePrContent: () => unsupported("generatePrContent"),
    generateBranchName: () => unsupported("generateBranchName"),
    generateThreadTitle: () => unsupported("generateThreadTitle"),
  };
};

export type DevinDriverEnv =
  | DevinAdapterV2DriverEnv
  | AcpRegistrySupport.AcpRegistryCatalog
  | BackgroundPolicy.BackgroundPolicy
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
  | ServerSettings.ServerSettingsService;

export const DevinDriver: ProviderDriver<DevinSettings, DevinDriverEnv> = {
  driverKind: DEVIN_DRIVER_KIND,
  metadata: {
    displayName: "Devin",
    supportsMultipleInstances: true,
  },
  configSchema: DevinSettings,
  defaultConfig: (): DevinSettings => decodeDevinSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const catalog = yield* AcpRegistrySupport.AcpRegistryCatalog;
      const runtimeCoordinator = yield* Effect.serviceOption(
        AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator,
      );
      if (Option.isSome(runtimeCoordinator)) {
        yield* runtimeCoordinator.value.clearAvailableCommands(instanceId);
        yield* runtimeCoordinator.value.clearLiveConfiguration(instanceId);
        yield* Effect.addFinalizer(() =>
          runtimeCoordinator.value
            .clearAvailableCommands(instanceId)
            .pipe(Effect.andThen(runtimeCoordinator.value.clearLiveConfiguration(instanceId))),
        );
      }
      const crypto = yield* Crypto.Crypto;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const httpClient = yield* HttpClient.HttpClient;
      const hostEnvironment = yield* HostProcessEnvironment;
      const serverConfig = yield* ServerConfig.ServerConfig;
      const serverSettings = yield* ServerSettings.ServerSettingsService;
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DEVIN_DRIVER_KIND,
        instanceId,
      });
      const identity = {
        instanceId,
        displayName,
        accentColor,
        continuationKey: continuationIdentity.continuationKey,
      };
      const effectiveConfig = { ...config, enabled } satisfies DevinSettings;
      const processEnvironment = mergeProviderInstanceEnvironment(environment, hostEnvironment);
      const resolveMaintenance = yield* makeCachedProviderMaintenanceResolution(
        resolveProviderMaintenanceCapabilitiesEffect(UPDATE, {
          binaryPath: effectiveConfig.binaryPath,
          env: processEnvironment,
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        ),
      );
      // Auth, session-management, and configuration probing reuse the
      // registry's agent-agnostic ACP helpers, resolved to the local devin
      // binary through a synthesized registry entry.
      const acpSettings = devinAcpRegistrySettings(effectiveConfig);
      const orchestrationAdapter = yield* DevinAdapterV2Driver.create({
        instanceId,
        displayName,
        accentColor,
        environment,
        enabled,
        config,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DEVIN_DRIVER_KIND,
              instanceId,
              detail: "Failed to build Devin orchestration adapter.",
              cause,
            }),
        ),
      );
      const readinessInput = {
        ...identity,
        settings: effectiveConfig,
        environment: processEnvironment,
      };
      const confirmedAuthentication =
        yield* AcpRegistryAuthenticationState.makeAcpRegistryAuthenticationState({
          cacheDir: serverConfig.providerStatusCacheDir,
          instanceId,
          settings: acpSettings,
          environment,
          processEnvironment,
        });
      const customModelSlugs = effectiveConfig.customModels.map((entry: CustomModelSetting) =>
        typeof entry === "string" ? entry : entry.slug,
      );
      const withLiveRuntimeState = (input: ServerProvider) =>
        Effect.gen(function* () {
          if (input.auth.status === "unauthenticated") yield* confirmedAuthentication.set(false);
          const provider =
            input.enabled &&
            input.installed &&
            input.auth.status === "unknown" &&
            (yield* confirmedAuthentication.get)
              ? { ...input, auth: { ...input.auth, status: "authenticated" as const } }
              : input;
          return yield* Option.isNone(runtimeCoordinator)
            ? Effect.succeed(provider)
            : Effect.all({
                commands: runtimeCoordinator.value.getAvailableCommands(instanceId),
                configuration: runtimeCoordinator.value.getLiveConfiguration(instanceId),
                authAction: runtimeCoordinator.value.getUrlAuthAction(instanceId),
              }).pipe(
                Effect.map(({ commands, configuration, authAction }) => {
                  const withCommands = applyAcpRegistryAvailableCommands(provider, commands);
                  const withConfiguration = Option.match(configuration, {
                    onNone: () => withCommands,
                    onSome: (liveConfiguration) =>
                      applyAcpRegistryLiveConfiguration(
                        withCommands,
                        liveConfiguration,
                        customModelSlugs,
                      ),
                  });
                  return applyAcpRegistryUrlAuthAction(withConfiguration, authAction);
                }),
              );
        });
      const checkProvider = checkDevinProviderReadiness(readinessInput).pipe(
        Effect.flatMap(withLiveRuntimeState),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      const enrichProvider = checkDevinProviderStatus(readinessInput, () =>
        probeAcpRegistryConfiguration({
          instanceId,
          settings: acpSettings,
          cwd: serverConfig.cwd,
          environment: processEnvironment,
        }),
      ).pipe(
        Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, catalog),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(Crypto.Crypto, crypto),
      );
      const enrichmentCache = yield* Ref.make<{
        readonly generation: number;
        readonly entry: {
          readonly provider: ServerProvider;
          readonly expiresAt: number;
        } | null;
      }>({ generation: 0, entry: null });
      const liveSnapshotSemaphore = yield* Semaphore.make(1);
      const invalidateEnrichmentCache = Ref.update(enrichmentCache, (current) => ({
        generation: current.generation + 1,
        entry: null,
      }));
      const enrichProviderCached = (baseSnapshot: ServerProvider) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const cacheState = yield* Ref.get(enrichmentCache);
          const cached = cacheState.entry;
          if (
            cached !== null &&
            cached.expiresAt > now &&
            cached.provider.version === baseSnapshot.version
          ) {
            return {
              provider: { ...cached.provider, checkedAt: baseSnapshot.checkedAt },
              generation: cacheState.generation,
            };
          }
          const enriched = yield* enrichProvider;
          if (enriched.status === "ready") {
            yield* Ref.update(enrichmentCache, (current) =>
              current.generation === cacheState.generation
                ? {
                    ...current,
                    entry: {
                      provider: enriched,
                      expiresAt: now + PROBE_SUCCESS_TTL_MS,
                    },
                  }
                : current,
            );
          }
          return { provider: enriched, generation: cacheState.generation };
        });
      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<DevinSettings>>({
        resolveMaintenance,
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: () => checkProvider,
        checkProvider,
        enrichSnapshot: ({ settings, snapshot, getSnapshot, publishSnapshot }) => {
          if (!snapshot.installed) return Effect.void;
          const publishEnrichment = Effect.all([
            Option.isSome(runtimeCoordinator)
              ? runtimeCoordinator.value.runBackgroundProbe("devin", enrichProviderCached(snapshot))
              : enrichProviderCached(snapshot).pipe(Effect.asSome),
            resolveMaintenance(),
          ]).pipe(
            Effect.flatMap(([enriched, maintenanceCapabilities]) =>
              Option.match(enriched, {
                onNone: () => Effect.void,
                onSome: ({ provider, generation }) =>
                  liveSnapshotSemaphore.withPermit(
                    Ref.get(enrichmentCache).pipe(
                      Effect.flatMap((current) =>
                        current.generation === generation
                          ? withLiveRuntimeState(provider).pipe(
                              Effect.flatMap((liveProvider) =>
                                enrichProviderSnapshotWithVersionAdvisory(
                                  liveProvider,
                                  maintenanceCapabilities,
                                  {
                                    enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
                                  },
                                ),
                              ),
                              Effect.flatMap(publishSnapshot),
                            )
                          : Effect.void,
                      ),
                    ),
                  ),
              }),
            ),
            Effect.provideService(HttpClient.HttpClient, httpClient),
          );
          if (Option.isNone(runtimeCoordinator)) return publishEnrichment;

          const publishLiveCommands = runtimeCoordinator.value.watchAvailableCommands(
            instanceId,
            ({ slashCommands, skills }) =>
              liveSnapshotSemaphore.withPermit(
                getSnapshot.pipe(
                  Effect.flatMap((current) =>
                    publishSnapshot({
                      ...current,
                      slashCommands,
                      skills,
                    }),
                  ),
                ),
              ),
          );
          const publishLiveConfiguration = runtimeCoordinator.value.watchLiveConfiguration(
            instanceId,
            (configuration) =>
              liveSnapshotSemaphore.withPermit(
                getSnapshot.pipe(
                  Effect.flatMap((current) =>
                    publishSnapshot(
                      applyAcpRegistryLiveConfiguration(current, configuration, customModelSlugs),
                    ),
                  ),
                ),
              ),
          );
          const publishUrlAuthAction = runtimeCoordinator.value.watchUrlAuthAction(
            instanceId,
            (action) =>
              liveSnapshotSemaphore.withPermit(
                getSnapshot.pipe(
                  Effect.flatMap((current) =>
                    publishSnapshot(
                      applyAcpRegistryUrlAuthAction(current, Option.fromNullishOr(action)),
                    ),
                  ),
                ),
              ),
          );
          return Effect.all(
            [
              publishEnrichment,
              publishLiveCommands,
              publishLiveConfiguration,
              publishUrlAuthAction,
            ],
            {
              concurrency: "unbounded",
              discard: true,
            },
          );
        },
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DEVIN_DRIVER_KIND,
              instanceId,
              detail: "Failed to build the Devin provider snapshot.",
              cause,
            }),
        ),
      );

      const provideAcpManagementServices = <A, E>(
        effect: Effect.Effect<
          A,
          E,
          | AcpRegistrySupport.AcpRegistryCatalog
          | ChildProcessSpawner.ChildProcessSpawner
          | Crypto.Crypto
        >,
      ): Effect.Effect<A, E> => {
        const provided = effect.pipe(
          Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, catalog),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(Crypto.Crypto, crypto),
        );
        return Option.isSome(runtimeCoordinator)
          ? provided.pipe(
              Effect.provideService(
                AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator,
                runtimeCoordinator.value,
              ),
            )
          : provided;
      };

      const clearLiveState = Option.isSome(runtimeCoordinator)
        ? runtimeCoordinator.value
            .clearLiveConfiguration(instanceId)
            .pipe(Effect.andThen(runtimeCoordinator.value.clearAvailableCommands(instanceId)))
        : Effect.void;
      const controller = yield* AcpRegistryAuth.makeAcpRegistryAuth({
        instanceId,
        settings: acpSettings,
        cwd: serverConfig.cwd,
        environment: processEnvironment,
        onChanged: (authenticated) =>
          confirmedAuthentication
            .set(authenticated)
            .pipe(
              Effect.andThen(authenticated ? Effect.void : clearLiveState),
              Effect.andThen(liveSnapshotSemaphore.withPermit(invalidateEnrichmentCache)),
              Effect.andThen(snapshot.refresh),
              Effect.asVoid,
            ),
      }).pipe(
        Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, catalog),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(Crypto.Crypto, crypto),
      );
      const auth = {
        ...controller,
        invalidate: (controller.invalidate ?? Effect.void).pipe(
          Effect.andThen(confirmedAuthentication.set(false)),
          Effect.andThen(clearLiveState),
          Effect.andThen(liveSnapshotSemaphore.withPermit(invalidateEnrichmentCache)),
          Effect.andThen(snapshot.refresh),
          Effect.asVoid,
        ),
      };

      return {
        instanceId,
        driverKind: DEVIN_DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        auth,
        snapshot: {
          ...snapshot,
          refresh: snapshot.refresh.pipe(
            Effect.tap(() => controller.refreshMethods ?? Effect.void),
          ),
        },
        orchestrationAdapter,
        textGeneration: makeUnsupportedTextGeneration(),
        // Session management talks to the local agent's session database.
        // Cloud threads resume by session id, but their list lives in Devin
        // Cloud, so management is wired only for the local transport.
        ...(effectiveConfig.cloud
          ? {}
          : {
              acpSessionManagement: {
                listSessions: ({ cwd, cursor }) =>
                  provideAcpManagementServices(
                    listAcpRegistrySessions({
                      instanceId,
                      settings: acpSettings,
                      cwd,
                      environment: processEnvironment,
                      ...(cursor === undefined ? {} : { cursor }),
                    }),
                  ),
                deleteSession: ({ cwd, sessionId }) =>
                  provideAcpManagementServices(
                    deleteAcpRegistrySession({
                      instanceId,
                      settings: acpSettings,
                      cwd,
                      environment: processEnvironment,
                      sessionId,
                    }),
                  ),
                listProviders: (cwd) =>
                  provideAcpManagementServices(
                    listAcpRegistryProviders({
                      instanceId,
                      settings: acpSettings,
                      cwd,
                      environment: processEnvironment,
                    }),
                  ),
                setProvider: ({ cwd, providerId, apiType, baseUrl, headers }) =>
                  provideAcpManagementServices(
                    setAcpRegistryProvider({
                      instanceId,
                      settings: acpSettings,
                      cwd,
                      environment: processEnvironment,
                      providerId,
                      apiType,
                      baseUrl,
                      ...(headers === undefined ? {} : { headers }),
                    }),
                  ).pipe(
                    Effect.tap(() => liveSnapshotSemaphore.withPermit(invalidateEnrichmentCache)),
                  ),
                disableProvider: ({ cwd, providerId }) =>
                  provideAcpManagementServices(
                    disableAcpRegistryProvider({
                      instanceId,
                      settings: acpSettings,
                      cwd,
                      environment: processEnvironment,
                      providerId,
                    }),
                  ).pipe(
                    Effect.tap(() => liveSnapshotSemaphore.withPermit(invalidateEnrichmentCache)),
                  ),
                logout: (cwd) => {
                  const logout = logoutAcpRegistry({
                    instanceId,
                    settings: acpSettings,
                    cwd,
                    environment: processEnvironment,
                  }).pipe(
                    Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, catalog),
                    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
                    Effect.provideService(Crypto.Crypto, crypto),
                    Effect.tap(() => confirmedAuthentication.set(false)),
                    Effect.tap(() =>
                      liveSnapshotSemaphore.withPermit(
                        invalidateEnrichmentCache.pipe(
                          Effect.andThen(
                            Option.isSome(runtimeCoordinator)
                              ? Effect.all(
                                  [
                                    runtimeCoordinator.value.clearAvailableCommands(instanceId),
                                    runtimeCoordinator.value.clearLiveConfiguration(instanceId),
                                  ],
                                  { concurrency: "unbounded", discard: true },
                                )
                              : Effect.void,
                          ),
                        ),
                      ),
                    ),
                  );
                  return Option.isSome(runtimeCoordinator)
                    ? logout.pipe(
                        Effect.provideService(
                          AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator,
                          runtimeCoordinator.value,
                        ),
                      )
                    : logout;
                },
              },
            }),
      } satisfies ProviderInstance;
    }),
};
