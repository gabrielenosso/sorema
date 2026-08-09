# sorema

Speak, and make it happen on your own machine.

Sorema listens in your browser, thinks in the cloud, and does the work on a computer you own. **This
repository is the part that runs on your computer** — the agent, and the command that installs it.

## Why this is open

You are being asked to run a daemon that can reach your files and start work on your behalf. That is
a lot of trust for a black box. Everything with access to your machine is here, so the claims below
can be checked rather than believed:

- The keypair that identifies this machine is generated locally, stored in `~/.sorema` readable only
  by you, and the private half never leaves. Pairing sends only the public half.
- The connection is outbound. Nothing listens, no port is opened, no address is registered.
- The agent can only see the folders named in `SOREMA_WORKSPACE_ROOTS`. With none named, it can see
  nothing. Paths are resolved with `realpath`, and traversal, symlink escapes, and sibling paths that
  merely share a prefix are all refused.
- There is no `exec` tool. The assistant cannot ask for an arbitrary command; it can only ask for the
  operations implemented here, each one validated against a schema on the way in and on the way out.
- Instructions reach a coding agent on stdin, never on a command line, so no shell metacharacter path
  exists on any platform.

The cloud side — the API, the coordination, the storage — is not in this repository and is not open.
That is the same split Tailscale makes, and for the same reason: what runs on your machine should be
auditable; what runs on ours is the service.

## Install

```bash
npx sorema@latest A1B2C3D4
```

That is the whole thing: it pairs, installs itself so it survives a reboot, and connects. Run it
again any time — it works out what is already done and does only the rest.

`@latest` matters. The command installs itself and never checks for a newer version afterwards, so
without it a machine keeps running whatever copy it already had.

The code comes from the web app, under "Pair your computer".

## Build it yourself

```bash
pnpm install
pnpm test
SOREMA_API_URL=… SOREMA_TUNNEL_URL=… pnpm build
```

The published command has the service's addresses compiled in. A build from source does not, and will
say so — supply your own, or point it at your own deployment.

## Verify what you installed

Releases are published from CI with npm provenance, which is a signed statement tying the tarball to
the commit it was built from. Reading the source only means something if the thing you installed came
from it:

```bash
npm view sorema --json | grep -A5 provenance
```

## Licence

GNU Affero General Public License v3.0. See [LICENSE](./LICENSE).

Copyright (c) 2026 Gabriele Nosso.

Read it, run it, change it, run your own copy. If you offer a modified version to other people over
a network, the AGPL requires you to publish your changes under the same terms. The source is open
because software that runs commands on your machine and holds your API key has no business being
unreadable.

The hosted service is a separate, closed codebase. If the AGPL does not suit what you want to build,
ask me about a commercial licence — I am the sole author, so I can grant one.
