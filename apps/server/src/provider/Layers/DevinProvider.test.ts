import { assert, describe, it } from "@effect/vitest";
import { AcpRegistryProbeResult, DevinSettings, ProviderInstanceId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import {
  buildDevinBaseSnapshot,
  buildDevinModelsFromProbe,
  parseDevinAuthStatusOutput,
} from "./DevinProvider.ts";

const INSTANCE_ID = ProviderInstanceId.make("devin");
const decodeDevinSettings = Schema.decodeSync(DevinSettings);
const decodeProbeResult = Schema.decodeSync(AcpRegistryProbeResult);

const identity = {
  instanceId: INSTANCE_ID,
  displayName: undefined,
  accentColor: undefined,
  continuationKey: "devin",
} as const;

const makeProbe = (overrides: Partial<Schema.Schema.Type<typeof AcpRegistryProbeResult>> = {}) =>
  decodeProbeResult({
    instanceId: INSTANCE_ID,
    ready: true,
    icon: null,
    authMethods: [],
    models: [],
    currentModelId: null,
    configOptions: [],
    sessionManagement: {
      canList: true,
      canLoad: true,
      canResume: true,
      canLogout: false,
      canDelete: true,
      canConfigureProviders: false,
    },
    ...overrides,
  });

const makeProbeResult = (probe: Schema.Schema.Type<typeof AcpRegistryProbeResult>) => ({
  probe,
  slashCommands: [],
  skills: [],
});

describe("parseDevinAuthStatusOutput", () => {
  it("parses a signed-in account with its email", () => {
    const parsed = parseDevinAuthStatusOutput(
      ["Logged in via Devin", "User: test", "Email: user@example.com", "Tier: Devin Max"].join(
        "\n",
      ),
    );
    assert.deepEqual(parsed, { status: "authenticated", email: "user@example.com" });
  });

  it("parses a signed-in account without an email field", () => {
    const parsed = parseDevinAuthStatusOutput("Logged in via API key\n");
    assert.deepEqual(parsed, { status: "authenticated", email: undefined });
  });

  it("parses signed-out output", () => {
    const parsed = parseDevinAuthStatusOutput("Not logged in. Run `devin auth login`.");
    assert.deepEqual(parsed, { status: "unauthenticated", email: undefined });
  });

  it("stays unknown for unrecognized output", () => {
    const parsed = parseDevinAuthStatusOutput("devin 3000.11.3");
    assert.deepEqual(parsed, { status: "unknown", email: undefined });
  });
});

describe("buildDevinModelsFromProbe", () => {
  it("falls back to the CLI-default model when no probe ran", () => {
    const models = buildDevinModelsFromProbe(undefined, undefined);
    assert.deepEqual(
      models.map((model) => model.slug),
      ["default"],
    );
    assert.isTrue(models[0]?.isDefault);
  });

  it("maps probed models and marks the session's current model", () => {
    const probe = makeProbe({
      models: [
        { id: "swe-2-max", name: "SWE-2 Max", description: null },
        { id: "swe-2-high", name: "SWE-2 High", description: null },
      ],
      currentModelId: "swe-2-high",
    });
    const models = buildDevinModelsFromProbe(probe, undefined);
    assert.deepEqual(
      models.map((model) => model.slug),
      ["swe-2-max", "swe-2-high"],
    );
    assert.isFalse(models[0]?.isDefault ?? false);
    assert.isTrue(models[1]?.isDefault);
  });

  it("merges configured custom models after the probed list", () => {
    const probe = makeProbe({
      models: [{ id: "swe-2-max", name: "SWE-2 Max", description: null }],
      currentModelId: "swe-2-max",
    });
    const models = buildDevinModelsFromProbe(probe, ["swe-custom-finetune"]);
    assert.isTrue(models.some((model) => model.slug === "swe-custom-finetune"));
  });
});

describe("buildDevinBaseSnapshot", () => {
  const baseInput = {
    ...identity,
    settings: decodeDevinSettings({ enabled: true }),
    checkedAt: "2026-01-01T00:00:00.000Z",
    installed: true,
    version: "3000.11.3",
    status: "ready" as const,
    auth: { status: "authenticated" as const, type: "account" as const },
  };

  it("exposes native session management for the local transport", () => {
    const snapshot = buildDevinBaseSnapshot({
      ...baseInput,
      probe: makeProbeResult(makeProbe()),
    });
    assert.deepEqual(snapshot.nativeSessions, {
      canList: true,
      canLoad: true,
      canResume: true,
      canDelete: true,
    });
  });

  it("hides native session management for the cloud transport", () => {
    const snapshot = buildDevinBaseSnapshot({
      ...baseInput,
      settings: decodeDevinSettings({ enabled: true, cloud: true }),
      probe: makeProbeResult(makeProbe()),
    });
    assert.deepEqual(snapshot.nativeSessions, {
      canList: false,
      canLoad: false,
      canResume: false,
      canDelete: false,
    });
    assert.isFalse(snapshot.configurableProviders);
    // The management-section logout targets the local session database and
    // stays hidden in cloud mode; account sign-out remains via
    // `setup.canAuthenticate`.
    assert.isUndefined(snapshot.auth.canLogout);
  });

  it("defaults canLogout to the authenticated state without a probe", () => {
    const authenticated = buildDevinBaseSnapshot(baseInput);
    assert.isTrue(authenticated.auth.canLogout === true);
    const unauthenticated = buildDevinBaseSnapshot({
      ...baseInput,
      auth: { status: "unauthenticated" as const },
    });
    assert.isFalse(unauthenticated.auth.canLogout === true);
  });

  it("carries the official registry icon and Devin presentation", () => {
    const snapshot = buildDevinBaseSnapshot(baseInput);
    assert.equal(
      snapshot.iconUrl,
      "https://cdn.agentclientprotocol.com/registry/v1/latest/devin.svg",
    );
    assert.equal(snapshot.driver, "devin");
    assert.isTrue(snapshot.showInteractionModeToggle === true);
    assert.isFalse(snapshot.supportsTextGeneration === true);
  });
});
