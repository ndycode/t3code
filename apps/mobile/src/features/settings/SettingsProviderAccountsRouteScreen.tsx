import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import { T, useGT, Var } from "gt-react-native";
import * as Dialog from "../../components/ui/Dialog";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthProvidersManageScope,
  isManagedDriverAllowed,
  isManagedSettingPath,
  type ProviderAuthResponse,
  type ProviderInstanceConfig,
  type ServerProvider,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useRef, useState } from "react";
import { Pressable, ScrollView, TextInput, useWindowDimensions, View } from "react-native";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { m } from "../../i18n/messages";

import type { MenuAction } from "@react-native-menu/menu";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText as Text } from "../../components/ui/AppText";
import { ControlPill } from "../../components/ui/ControlPill";
import { Menu } from "../../components/ui/Menu";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { ThemedSwitch } from "../../components/ui/ThemedSwitch";
import { environmentPresentations } from "../../state/presentation";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentsWithScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { ListActionRow as SettingsActionRow } from "../../components/ui/ListActionRow";
import { useSettingsEnvironmentMenu } from "./components/SettingsEnvironmentFilterHeader";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { AddClaudeAccount, ClaudeAccount } from "./ClaudeAccounts";
import { CLAUDE_DRIVER } from "./claude-accounts";
import { useSettingsEnvironmentFilter, type SettingsTarget } from "./settings-environment-filter";

export function SettingsProviderAccountsRouteScreen() {
  const gt = useGT();
  const environmentMenu = useSettingsEnvironmentMenu();
  const { selectedTargets } = useSettingsEnvironmentFilter();
  const permittedEnvironments = useEnvironmentsWithScope(selectedTargets, AuthProvidersManageScope);
  const providersByEnvironment = useAtomValue(environmentPresentations.providersByEnvironmentAtom);
  const insets = useSafeAreaInsets();
  return (
    <SettingsScreen title={gt("Providers")} menus={[environmentMenu]}>
      <ScreenScrollView
        className="flex-1"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {selectedTargets.length === 0 ? (
          <Text className="text-foreground-muted">
            <T>Select a connected environment.</T>
          </Text>
        ) : (
          selectedTargets.map((environment) => (
            <SettingsSection key={environment.environmentId} title={environment.label}>
              {!permittedEnvironments.has(environment.environmentId) ? (
                <View className="gap-1 p-4">
                  <Text className="text-base text-foreground">
                    <T>Limited permissions</T>
                  </Text>
                  <Text className="text-sm text-foreground-muted">
                    {gt(
                      "This session can view {environment}''s providers but can't change their settings.",
                      { environment: environment.label },
                    )}
                  </Text>
                </View>
              ) : (
                <EnvironmentProviders
                  environment={environment}
                  providers={managedProviders(environment, providersByEnvironment)}
                />
              )}
            </SettingsSection>
          ))
        )}
      </ScreenScrollView>
    </SettingsScreen>
  );
}

function EnvironmentProviders({
  environment,
  providers,
}: {
  readonly environment: SettingsTarget;
  readonly providers: ReadonlyArray<ServerProvider>;
}) {
  const gt = useGT();
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
    reportDefect: false,
  });
  const refreshPendingRef = useRef(false);
  const [refreshPending, setRefreshPending] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  // Claude has no in-app sign-in; each account is its own instance on a signed-in config folder.
  const claudeAccounts = providers.filter(
    (provider) => provider.driver === CLAUDE_DRIVER && !canManageProvider(provider),
  );
  const accounts = providers.filter(
    (provider) => !(provider.driver === CLAUDE_DRIVER && !canManageProvider(provider)),
  );
  const canAddClaude = isManagedDriverAllowed(
    environment.serverConfig.managedPolicy,
    CLAUDE_DRIVER,
  );
  async function handleRefresh() {
    if (refreshPendingRef.current) return;
    refreshPendingRef.current = true;
    setRefreshPending(true);
    setRefreshError(null);
    const result = await refreshProviders({
      environmentId: environment.environmentId,
      input: { reloadSecrets: true },
    });
    refreshPendingRef.current = false;
    setRefreshPending(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      setRefreshError(
        failure instanceof Error
          ? (errorDisplayMessage(failure, m) ?? failure.message)
          : gt("Could not refresh providers."),
      );
    }
  }
  return (
    <>
      <SettingsActionRow
        icon="arrow.clockwise"
        label={gt("Refresh providers")}
        disabled={refreshPending}
        loading={refreshPending}
        onPress={() => {
          void handleRefresh();
        }}
      />
      {refreshError ? (
        <Text accessibilityRole="alert" className="px-4 pb-3 text-danger-foreground">
          {refreshError}
        </Text>
      ) : null}
      {accounts.map((provider) => (
        <ProviderAccount
          key={provider.instanceId}
          environment={environment}
          provider={provider}
          divider
        />
      ))}
      {accounts.length === 0 && claudeAccounts.length === 0 ? (
        <Text className="border-t border-border-subtle p-4 text-foreground-muted">
          <T>No providers configured.</T>
        </Text>
      ) : null}
      {claudeAccounts.map((provider) => (
        <ClaudeAccount
          key={provider.instanceId}
          environment={environment}
          provider={provider}
          divider
        />
      ))}
      {canAddClaude ? <AddClaudeAccount environment={environment} /> : null}
    </>
  );
}

/** Providers the environment's managed policy allows; the rest cannot run or sign in. */
function managedProviders(
  environment: SettingsTarget,
  providersByEnvironment: ReadonlyMap<string, ReadonlyArray<ServerProvider>>,
) {
  return (providersByEnvironment.get(environment.environmentId) ?? []).filter((provider) =>
    isManagedDriverAllowed(environment.serverConfig.managedPolicy, provider.driver),
  );
}

function canManageProvider(provider: ServerProvider) {
  return Boolean(
    provider.setup?.canAuthenticate || (provider.driver === "acpRegistry" && provider.installed),
  );
}

function ProviderAccount({
  environment,
  provider,
  divider,
}: {
  readonly environment: SettingsTarget;
  readonly provider: ServerProvider;
  readonly divider: boolean;
}) {
  const gt = useGT();
  const environmentId = environment.environmentId;
  const instanceId = provider.instanceId;
  const supportsAuth = canManageProvider(provider);
  const target = { environmentId, input: { instanceId } };
  const auth = useEnvironmentQuery(
    supportsAuth ? serverEnvironment.providerAuthState(target) : null,
  );
  const options = { reportFailure: false, reportDefect: false };
  const start = useAtomCommand(serverEnvironment.startProviderAuth, options);
  const respond = useAtomCommand(serverEnvironment.respondProviderAuth, options);
  const complete = useAtomCommand(serverEnvironment.completeProviderAuth, options);
  const cancel = useAtomCommand(serverEnvironment.cancelProviderAuth, options);
  const logout = useAtomCommand(serverEnvironment.logoutProviderAuth, options);
  const removeMethod = useAtomCommand(serverEnvironment.removeProviderAuthMethod, options);
  const mutateProviderInstance = useAtomCommand(serverEnvironment.mutateProviderInstance, options);
  const canRemoveMethod = useAtomValue(
    serverEnvironment.removeProviderAuthMethod.permissionAtom(environmentId),
  );
  const enabledLocked = isManagedSettingPath(
    environment.serverConfig.managedPolicy,
    `providerInstances.${instanceId}.enabled`,
  );
  // Matches ListRowLayout: large text stacks the action below instead of squeezing the status.
  const stacked = useWindowDimensions().fontScale >= 1.5;
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState({ id: "", values: {} as Record<string, string> });
  const state = auth.data;
  const interaction = state?.interaction;
  const draftId = `${state?.flowId ?? ""}:${interaction?.id ?? ""}`;
  const values = draft.id === draftId ? draft.values : {};
  const active =
    state?.phase === "starting" || state?.phase === "waiting" || state?.phase === "verifying";
  const signedIn =
    provider.auth.status === "authenticated" ||
    (provider.auth.status === "unknown" && state?.phase === "succeeded");
  const isDiscovering =
    supportsAuth &&
    provider.driver === "acpRegistry" &&
    !active &&
    !signedIn &&
    !auth.error &&
    state?.methods === undefined;
  const needsExternalSetup =
    supportsAuth &&
    !active &&
    !signedIn &&
    (provider.setup?.canAuthenticate === false ||
      (provider.driver === "acpRegistry" && state?.methods?.length === 0));
  const url =
    interaction?.type === "browser" || interaction?.type === "deviceCode"
      ? interaction.url
      : state?.authorizationUrl;
  const disabled = pending || auth.error !== null || isDiscovering;
  async function run(command: () => Promise<AtomCommandResult<unknown, unknown>>) {
    if (pendingRef.current) return false;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    const result = await command();
    pendingRef.current = false;
    setPending(false);
    if (result._tag === "Success") return true;
    if (!isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      setError(
        failure instanceof Error
          ? (errorDisplayMessage(failure, m) ?? failure.message)
          : gt("Could not update provider sign-in."),
      );
    }
    return false;
  }
  function send(response: ProviderAuthResponse) {
    if (!state?.flowId || !interaction) return Promise.resolve(false);
    return run(() =>
      respond({
        environmentId,
        input: { instanceId, flowId: state.flowId!, interactionId: interaction.id, response },
      }),
    );
  }
  function field(name: string, label: string, secret: boolean) {
    return (
      <TextInput
        accessibilityLabel={label}
        className="rounded-lg border border-border-subtle px-3 py-2 text-base text-foreground"
        placeholderTextColorClassName="accent-foreground-muted"
        placeholder={label}
        secureTextEntry={secret}
        autoCapitalize="none"
        autoCorrect={false}
        editable={!disabled}
        maxLength={secret && interaction?.type === "terminal" ? 4_095 : 16_384}
        value={values[name] ?? ""}
        onChangeText={(value) => setDraft({ id: draftId, values: { ...values, [name]: value } })}
      />
    );
  }
  const name = provider.displayName ?? provider.driver;
  const email = signedIn && !active && provider.enabled ? provider.auth.email?.trim() : undefined;
  const methods = state?.methods ?? [];
  // The status line says why a provider that is missing or turned off can't sign in.
  const canSignIn =
    supportsAuth &&
    !active &&
    !needsExternalSetup &&
    provider.setup?.canAuthenticate !== false &&
    provider.enabled &&
    provider.installed;
  const signInDisabled = disabled || state === null;
  const canSignOut =
    supportsAuth &&
    !active &&
    signedIn &&
    (provider.auth.canLogout ?? provider.setup?.canAuthenticate);
  const showCallback =
    Boolean(url) && (interaction?.type === "browser" ? interaction.acceptsCallback : !interaction);
  const usesCredentials =
    provider.driver === "antigravity" &&
    (provider.auth.type === "gemini-api-key" || provider.auth.type === "agent-platform");
  const status =
    active || state?.phase === "failed" || state?.phase === "cancelled"
      ? state.message
      : !provider.enabled
        ? gt("Turned off")
        : signedIn
          ? gt("Signed in")
          : isDiscovering
            ? gt("Discovering sign-in methods…")
            : !provider.installed
              ? gt("Not installed")
              : needsExternalSetup
                ? gt("No in-app sign-in advertised. Follow the provider's docs to finish setup.")
                : provider.status === "ready"
                  ? gt("Ready")
                  : (provider.status === "warning" || provider.status === "error") &&
                      provider.message
                    ? provider.message
                    : usesCredentials
                      ? gt("Connect to load models")
                      : gt("Not signed in");
  function toggleEnabled(enabled: boolean) {
    if (enabledLocked || pending || active) return;
    const existing = environment.serverConfig.settings.providerInstances[instanceId];
    const instance: ProviderInstanceConfig = existing
      ? { ...existing, enabled }
      : {
          driver: provider.driver,
          ...(provider.displayName ? { displayName: provider.displayName } : {}),
          enabled,
        };
    void run(() =>
      mutateProviderInstance({
        environmentId,
        input: {
          patch: {},
          providerInstanceMutation: {
            operation: "upsert",
            instanceId,
            instance,
          },
        },
      }),
    );
  }
  // A provider with several sign-in methods picks one from a menu on the same control.
  const methodActions: MenuAction[] = methods.map((method) => ({
    id: `method:${method.id}`,
    title: method.name,
  }));
  const removableMethods = methods.filter((method) => method.canRemove);
  const removeActions: MenuAction[] = removableMethods.length
    ? [
        {
          id: "remove",
          title: gt("Remove incomplete connection"),
          attributes: { disabled: disabled || active || !canRemoveMethod },
          subactions: removableMethods.map((method) => ({
            id: `remove:${method.id}`,
            title: method.name,
            attributes: { destructive: true, disabled: disabled || active || !canRemoveMethod },
          })),
        },
      ]
    : [];
  function startSignIn(methodId?: string) {
    void run(() => start(methodId ? { environmentId, input: { instanceId, methodId } } : target));
  }
  function signOut() {
    Dialog.alert(
      gt("Sign out?"),
      gt(
        "Running threads sharing this sign-in on {environment} will stop. Thread history is kept.",
        { environment: environment.label },
      ),
      [
        { text: gt("Cancel"), style: "cancel" },
        {
          text: gt("Sign out"),
          style: "destructive",
          onPress: () => {
            void run(() => logout(target));
          },
        },
      ],
    );
  }
  function onMenuAction(id: string) {
    if (id === "signOut") signOut();
    // iOS keeps a disabled submenu's children selectable, so sign-in guards here too.
    else if (signInDisabled) return;
    else if (id.startsWith("remove:")) {
      if (active || !canRemoveMethod) return;
      const methodId = id.slice("remove:".length);
      if (!removableMethods.some((method) => method.id === methodId)) return;
      void run(() => removeMethod({ environmentId, input: { instanceId, methodId } }));
    } else if (id.startsWith("method:")) startSignIn(id.slice("method:".length));
    else if (id === "change") startSignIn();
  }
  const accountActions: MenuAction[] = [
    ...removeActions,
    ...(canSignIn
      ? [
          {
            id: "change",
            title: gt("Change account"),
            image: "person.crop.circle",
            attributes: { disabled: signInDisabled },
            ...(methodActions.length > 1
              ? {
                  subactions: methodActions.map((action) => ({
                    ...action,
                    attributes: { disabled: signInDisabled },
                  })),
                }
              : {}),
          },
        ]
      : []),
    ...(canSignOut
      ? [
          {
            id: "signOut",
            title: gt("Sign out"),
            image: "rectangle.portrait.and.arrow.right",
            attributes: { destructive: true, disabled: disabled || state === null },
          },
        ]
      : []),
  ];
  const trailing = pending ? (
    <View className="h-11 w-11 items-center justify-center">
      <AppActivityIndicator colorClassName="accent-icon" />
    </View>
  ) : needsExternalSetup && provider.setup?.documentationUrl ? (
    <ControlPill
      variant="pill"
      label={gt("Docs")}
      onPress={() => {
        void tryOpenExternalUrl(provider.setup!.documentationUrl!).then((opened) => {
          if (!opened) setError(gt("Could not open the provider docs."));
        });
      }}
    />
  ) : active && state?.flowId ? (
    <ControlPill
      variant="pill"
      label={gt("Cancel")}
      accessibilityLabel={gt("Cancel {provider} sign-in", { provider: name })}
      disabled={disabled}
      onPress={() => {
        void run(() => cancel({ environmentId, input: { instanceId, flowId: state.flowId! } }));
      }}
    />
  ) : signedIn && !active && accountActions.length > 0 ? (
    <Menu
      accessible
      accessibilityRole="button"
      accessibilityLabel={gt("{provider} account options", { provider: name })}
      title={name}
      actions={accountActions}
      onPressAction={({ nativeEvent }) => onMenuAction(nativeEvent.event)}
    >
      <ControlPill
        icon="ellipsis"
        accessibilityLabel={gt("{provider} account options", { provider: name })}
      />
    </Menu>
  ) : canSignIn && !signedIn && methodActions.length > 1 && !signInDisabled ? (
    <Menu
      accessible
      accessibilityRole="button"
      accessibilityLabel={gt("Sign in to {provider}", { provider: name })}
      title={gt("Sign in with")}
      actions={[...methodActions, ...removeActions]}
      onPressAction={({ nativeEvent }) => onMenuAction(nativeEvent.event)}
    >
      <ControlPill
        variant="primary"
        label={gt("Sign in")}
        accessibilityLabel={gt("Sign in to {provider}", { provider: name })}
      />
    </Menu>
  ) : canSignIn && !signedIn ? (
    <ControlPill
      variant="primary"
      label={usesCredentials ? gt("Connect") : gt("Sign in")}
      accessibilityLabel={
        usesCredentials
          ? gt("Connect to {provider}", { provider: name })
          : gt("Sign in to {provider}", { provider: name })
      }
      disabled={signInDisabled}
      onPress={() => startSignIn()}
    />
  ) : null;
  return (
    <View className={divider ? "border-t border-border-subtle" : undefined}>
      <View
        className={
          stacked
            ? "min-h-16 items-start gap-3 px-4 py-3"
            : "min-h-16 flex-row items-center gap-3 px-4 py-3"
        }
      >
        <ProviderAccountSummary key={email} name={name} status={status} email={email} />
        <View className="flex-row items-center gap-2">
          {trailing}
          <ThemedSwitch
            accessibilityLabel={gt("Enable {provider}", { provider: name })}
            disabled={enabledLocked || pending || active}
            value={provider.enabled}
            onValueChange={toggleEnabled}
          />
        </View>
      </View>
      {interaction?.type === "deviceCode" ||
      interaction?.type === "terminal" ||
      interaction?.type === "credentials" ||
      showCallback ||
      error ||
      auth.error ? (
        <View className="gap-2 px-4 pb-3">
          {interaction?.type === "deviceCode" ? (
            <Text selectable className="text-foreground">
              <T>
                Enter code <Var>{interaction.userCode}</Var> on the sign-in page.
              </T>
            </Text>
          ) : null}
          {interaction?.type === "terminal" ? (
            <>
              <ScrollView className="max-h-64" nestedScrollEnabled>
                <Text selectable className="font-mono text-sm text-foreground">
                  {interaction.output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")}
                </Text>
              </ScrollView>
              {field("input", gt("Terminal response"), true)}
              <SettingsActionRow
                icon="arrow.up"
                label={gt("Send response")}
                disabled={disabled}
                onPress={() => {
                  void send({ type: "terminal", data: `${values.input ?? ""}\r` }).then((sent) => {
                    if (sent) setDraft({ id: "", values: {} });
                  });
                }}
              />
            </>
          ) : null}
          {interaction?.type === "credentials" ? (
            <>
              {interaction.fields.map((entry) => (
                <View key={entry.name}>{field(entry.name, entry.label, entry.secret)}</View>
              ))}
              <SettingsActionRow
                icon="person.crop.circle"
                label={gt("Connect")}
                disabled={disabled}
                onPress={() => {
                  void send({ type: "credentials", values }).then((sent) => {
                    if (sent) setDraft({ id: "", values: {} });
                  });
                }}
              />
            </>
          ) : null}
          {showCallback ? (
            <>
              {field("callback", gt("Final localhost URL"), false)}
              <SettingsActionRow
                icon="arrow.right"
                label={gt("Continue")}
                disabled={disabled || !values.callback?.trim()}
                onPress={() => {
                  if (!state?.flowId) return;
                  void run(() =>
                    complete({
                      environmentId,
                      input: { instanceId, flowId: state.flowId!, callbackUrl: values.callback! },
                    }),
                  ).then((sent) => {
                    if (sent) setDraft({ id: "", values: {} });
                  });
                }}
              />
            </>
          ) : null}
          {error || auth.error ? (
            <Text accessibilityRole="alert" className="text-danger-foreground">
              {error ?? auth.error}
            </Text>
          ) : null}
        </View>
      ) : null}
      {url ? (
        <SettingsActionRow
          icon="globe"
          label={gt("Open sign-in page")}
          disabled={disabled}
          onPress={() => {
            void (async () => {
              if (
                interaction?.type === "browser" &&
                interaction.requiresConsent &&
                !(await send({ type: "browser", action: "accept" }))
              )
                return;
              if (!(await tryOpenExternalUrl(url, "provider-auth")))
                setError(gt("Could not open the sign-in page."));
            })().catch(() => setError(gt("Could not open the sign-in page.")));
          }}
        />
      ) : null}
    </View>
  );
}

function ProviderAccountSummary({
  name,
  status,
  email,
}: {
  readonly name: string;
  readonly status: string | null | undefined;
  readonly email: string | undefined;
}) {
  const gt = useGT();
  const [revealed, setRevealed] = useState(false);
  const content = (
    <>
      <Text textRole="body" className="text-foreground" numberOfLines={1}>
        {name}
      </Text>
      <Text accessibilityLiveRegion="polite" textRole="footnote" className="text-foreground-muted">
        {email ? `${status} · ${revealed ? email : "••••••@••••••"}` : status}
      </Text>
    </>
  );
  if (!email) {
    return (
      <View
        accessible
        accessibilityLabel={[name, status].filter(Boolean).join(", ")}
        className="min-w-0 shrink grow gap-0.5"
      >
        {content}
      </View>
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[name, status, revealed ? email : null].filter(Boolean).join(", ")}
      accessibilityHint={revealed ? gt("Hides the account email") : gt("Reveals the account email")}
      onPress={() => setRevealed((value) => !value)}
      className="min-w-0 shrink grow gap-0.5"
    >
      {content}
    </Pressable>
  );
}
