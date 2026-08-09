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

`@latest` matters. The command installs itself and never checks for a newer version afterwards, so
without it a machine keeps running whatever copy it already had.

## What it does to your machine

- It generates a keypair on first run, stored in `~/.sorema`, readable only by you. The private half
  never leaves the machine — pairing sends only the public half.
- It reaches out. Nothing listens for incoming connections, and no port is opened on your router.
- It can only see the folders you list in `SOREMA_WORKSPACE_ROOTS`. With none listed, it can see
  nothing.
- There is no `exec` tool. The assistant cannot ask it to run an arbitrary command; it can only ask
  for the operations this program implements.

## Licence

Elastic License 2.0. You may read it, run it, and modify it for yourself. You may not offer it to
other people as a hosted or managed service. See [LICENSE](./LICENSE).
