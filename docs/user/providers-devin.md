# Devin

T3 Code can use your existing Devin CLI installation while keeping Devin's account, models, modes,
and native session history. Threads can run locally through `devin acp` or relay to Devin Cloud.

## Set Up Devin

1. Install the Devin CLI on the machine running the T3 Code server
   (`https://cli.devin.ai/install.sh`).
2. Run `devin auth login` once in a terminal and finish the sign-in you normally use.
3. Open T3 Code Settings, enable Devin, and refresh the provider.

If `devin` is not on the server's `PATH`, set Devin's binary path to the executable. T3 Code reads
the account you already signed in to; it does not ask for a separate token.

You can also sign in from the provider card with Devin's browser flow. Signing out stops running
threads for Devin instances on the environment; thread history and workspace files are kept.

## Local and Devin Cloud

The **Devin Cloud** setting changes where sessions run:

- **Off (default):** sessions run through the local `devin acp` server on the machine hosting your
  T3 Code server.
- **On:** sessions relay to Devin Cloud (`devin acp --cloud`) on the same account. Cloud threads
  follow your Devin Cloud environment and billing.

Native session listing and deletion stay local either way: they read the local agent's session
database, so they are offered only when Devin Cloud is off.

## What Carries Over

The model picker lists the model families your Devin account can use, including the SWE-2 family.
The `default` model follows whatever model the Devin CLI session currently selects; other settings
the session offers, such as thought level, appear in the composer's model options menu. Models and
options that change while a session is running update the picker without waiting for another
provider probe.

Slash commands Devin provides appear under **Provider** in the `/` menu. Devin subagent runs
appear in the shared subagent UI, and prompts can include image attachments.

## Permission Modes

T3 Code applies the composer permission mode through Devin's native session modes:

- **Supervised** runs Devin's `ask` mode and routes every approval through the thread.
- **Auto-accept edits** runs `accept-edits`: workspace edits proceed, commands still ask.
- **Auto** runs `smart`: Devin's safety classifier decides which commands proceed.
- **Full access** runs `bypass`: actions proceed without approval.

Devin runs commands through T3 Code's terminals, so terminal creation follows the thread's
permission mode as well. The **Plan** toggle selects Devin's native `plan` session mode and
restores the previous mode when toggled back.

An explicit approval or sandbox policy on a thread always forces Devin's asking mode so T3's
approval flow governs the action, regardless of the stored permission mode.

## Native Sessions

Expand the Devin provider card, choose a project, and select **List sessions** to browse the local
Devin session history. Importing one creates a deterministic T3 thread backed by that session;
importing it again returns the existing thread. Devin sessions can also be deleted from the same
section.

## Devin as an ACP Registry agent

Devin remains available through the generic **ACP Registry** driver (`devin` agent). Existing
registry-based Devin instances keep working unchanged; the dedicated Devin provider adds Devin
Cloud mode, CLI auth and update checks, and Devin's own settings surface. You can run both side by
side — they resolve the same `devin` binary unless you override the binary path.

## Troubleshooting

- If Devin shows as not installed, confirm `devin --version` runs on the server machine, then set
  the binary path and refresh.
- If Devin is installed but not signed in, run `devin auth login` or use the provider card's
  browser sign-in, then refresh.
- If no models appear, the provider keeps a `Devin default` fallback. Confirm `devin models list`
  works on the server and refresh the provider.
- Devin sessions are not used for T3's app-owned text generation (thread titles, commit messages,
  PR descriptions). Configure a text-generation-capable provider for those actions.
