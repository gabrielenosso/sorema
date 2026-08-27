# sorema

Speak, and make it happen on your own machine.

Sorema listens in your browser, thinks in the cloud, and does the work on a computer you own. This
package is the part that runs on your computer. Everything else is already running.

## Use it

Open the web app, sign in, and it will show you an eight-character code. Then, on the machine you
want to reach:

```bash
npx sorema@latest A1B2C3D4
```

That is the whole thing: it pairs, installs itself so it survives a reboot, and connects. Run it
again any time — it works out what is already done and does only the rest.

`@latest` matters. Run the same command again whenever the web app offers an update: it installs the
new durable copy, replaces the background service and reconnects without changing the machine's
identity, projects or saved sessions.

Codex and Claude Code keep their own login. An installed but signed-out Claude CLI is not advertised
as ready; sign in with `claude auth login`, then run `npx sorema@latest` again.

## What it does to your machine

- It generates a keypair on first run, stored in `~/.sorema`, readable only by you. The private half
  never leaves the machine — pairing sends only the public half.
- It reaches out. Nothing listens for incoming connections, and no port is opened on your router.
- It can only see the folders you list in `SOREMA_WORKSPACE_ROOTS`. With none listed, it can see
  nothing.
- There is no `exec` tool. The assistant cannot ask it to run an arbitrary command; it can only ask
  for the operations this program implements.
- It never gives a coding agent your browser. Sorema does not pass Claude Code `--chrome` and has no
  command to turn that on. Everything a job does here is meant to be undone from your own git
  history, and an action taken on a signed-in site is the one thing that cannot be. A Codex plugin
  you installed yourself is outside this: what Codex can reach is decided by Codex's configuration.

## Licence

GNU Affero General Public License v3.0 only (AGPL-3.0-only). See [LICENSE](./LICENSE).
