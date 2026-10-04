import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DevinSettings,
  ProviderInstanceId,
  ProviderSessionId,
  type RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import { assert, describe, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as ServerConfig from "../../config.ts";
import * as IdAllocator from "../IdAllocator.ts";
import { ProviderAdapterV2RuntimePolicy } from "../ProviderAdapter.ts";
import {
  DevinProviderCapabilitiesV2,
  devinSessionModeForPolicy,
  makeDevinAcpAdapterFlavor,
  makeDevinAdapterV2,
  type DevinAdapterV2Options,
} from "./DevinAdapterV2.ts";

const TEST_DEVIN_SETTINGS = Schema.decodeSync(DevinSettings)({
  binaryPath: "devin-launch-test",
});
const CLOUD_DEVIN_SETTINGS = Schema.decodeSync(DevinSettings)({
  binaryPath: "devin-launch-test",
  cloud: true,
});

function runtimePolicy(input: {
  readonly runtimeMode: RuntimeMode;
  readonly approvalPolicy?: unknown;
  readonly sandboxPolicy?: unknown;
}) {
  return ProviderAdapterV2RuntimePolicy.make({
    runtimeMode: input.runtimeMode,
    interactionMode: "default",
    cwd: "/workspace",
    ...(input.approvalPolicy === undefined ? {} : { approvalPolicy: input.approvalPolicy }),
    ...(input.sandboxPolicy === undefined ? {} : { sandboxPolicy: input.sandboxPolicy }),
  });
}

describe("devinSessionModeForPolicy", () => {
  it("maps T3 runtime modes onto Devin's native session modes", () => {
    assert.equal(
      devinSessionModeForPolicy(runtimePolicy({ runtimeMode: "approval-required" })),
      "ask",
    );
    assert.equal(
      devinSessionModeForPolicy(runtimePolicy({ runtimeMode: "auto-accept-edits" })),
      "accept-edits",
    );
    assert.equal(devinSessionModeForPolicy(runtimePolicy({ runtimeMode: "auto" })), "smart");
    assert.equal(
      devinSessionModeForPolicy(runtimePolicy({ runtimeMode: "full-access" })),
      "bypass",
    );
  });

  it("forces the asking mode whenever an explicit approval or sandbox policy governs", () => {
    assert.equal(
      devinSessionModeForPolicy(
        runtimePolicy({ runtimeMode: "full-access", approvalPolicy: "on-request" }),
      ),
      "ask",
    );
    assert.equal(
      devinSessionModeForPolicy(
        runtimePolicy({
          runtimeMode: "auto",
          approvalPolicy: "never",
          sandboxPolicy: { type: "readOnly" },
        }),
      ),
      "ask",
    );
    assert.equal(
      devinSessionModeForPolicy(
        runtimePolicy({
          runtimeMode: "auto-accept-edits",
          sandboxPolicy: { type: "workspaceWrite", writableRoots: [], networkAccess: false },
        }),
      ),
      "ask",
    );
  });
});

describe("DevinAdapterV2 flavor", () => {
  const flavor = () =>
    makeDevinAcpAdapterFlavor({
      instanceId: ProviderInstanceId.make("devin-test"),
      settings: TEST_DEVIN_SETTINGS,
      environment: {},
      makeRuntime: () => Effect.never,
    } as unknown as DevinAdapterV2Options);

  it("registers the dedicated devin driver and Cognition client metadata", () => {
    const next = flavor();
    assert.equal(next.driver, "devin");
    assert.deepEqual(next.clientCapabilitiesMeta, {
      "cognition.ai/subagentSupport": true,
      "cognition.ai/messageGrouping": true,
    });
  });

  it("declares the optional ACP features verified by the Devin handshake", () => {
    assert.isTrue(DevinProviderCapabilitiesV2.sessions.supportsModelSwitchInSession);
    assert.isTrue(DevinProviderCapabilitiesV2.sessions.supportsRuntimeModeSwitchInSession);
    assert.isTrue(DevinProviderCapabilitiesV2.threads.canReadThreadSnapshot);
    assert.isTrue(DevinProviderCapabilitiesV2.tools.supportsMcpTools);
    assert.isTrue(DevinProviderCapabilitiesV2.subagents.supportsSubagents);
    assert.isTrue(DevinProviderCapabilitiesV2.subagents.emitsSubagentLifecycle);
    assert.isTrue(DevinProviderCapabilitiesV2.checkpointing.providerCanReadConversationSnapshot);
  });

  it("omits coordinator hooks when no runtime coordinator is installed", () => {
    const next = flavor();
    assert.isUndefined(next.onAvailableCommandsUpdate);
    assert.isUndefined(next.onSessionConfigurationUpdate);
    assert.isUndefined(next.onUrlElicitation);
  });

  it("lets Devin's session mode gate its own terminal ops", () => {
    // Devin never emits session/request_permission in any mode, so T3's
    // ask-gated terminal/create could never be satisfied.
    assert.isTrue(flavor().unguardedClientTerminals);
  });
});

describe("Devin launch argv", () => {
  const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "t3-devin-v2-launch-",
  }).pipe(Layer.provide(NodeServices.layer));
  const testLayer = Layer.mergeAll(NodeServices.layer, IdAllocator.layer, serverConfigLayer);

  // Opens a session through the adapter's own Devin runtime factory and
  // returns the argv it tried to launch. The spawn fails after recording, so
  // no process starts.
  const launchArgs = (settings: DevinSettings) =>
    Effect.gen(function* () {
      const launches: Array<ReadonlyArray<string>> = [];
      const childProcessSpawner = ChildProcessSpawner.make((command) => {
        if (command._tag === "StandardCommand") launches.push(command.args);
        return Effect.fail(
          PlatformError.systemError({
            _tag: "NotFound",
            module: "devin-launch-test",
            method: "spawn",
          }),
        );
      });
      const instanceId = ProviderInstanceId.make("devin-launch-test");
      const adapter = makeDevinAdapterV2({
        instanceId,
        settings,
        environment: {},
        childProcessSpawner,
        crypto: yield* Crypto.Crypto,
        fileSystem: yield* FileSystem.FileSystem,
        idAllocator: yield* IdAllocator.IdAllocatorV2,
        serverConfig: yield* ServerConfig.ServerConfig,
        selfInvocation: yield* resolveSelfInvocation(),
      });
      yield* adapter
        .openSession({
          threadId: ThreadId.make("devin-launch-test"),
          providerSessionId: ProviderSessionId.make("devin-launch-test"),
          modelSelection: { instanceId, model: "default" },
          runtimePolicy: runtimePolicy({ runtimeMode: "auto" }),
        })
        .pipe(Effect.scoped, Effect.ignore);
      return launches;
    }).pipe(
      // Keep the launch argv unwrapped by the Linux cgroup shim.
      Effect.provideService(HostProcessPlatform, "darwin"),
      Effect.provide(testLayer),
    );

  it.effect("launches the local ACP server", () =>
    Effect.gen(function* () {
      assert.deepEqual(yield* launchArgs(TEST_DEVIN_SETTINGS), [["acp"]]);
    }),
  );

  it.effect("launches the Devin Cloud relay in cloud mode", () =>
    Effect.gen(function* () {
      assert.deepEqual(yield* launchArgs(CLOUD_DEVIN_SETTINGS), [["acp", "--cloud"]]);
    }),
  );
});
