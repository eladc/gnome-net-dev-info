# Net Device Info

A GNOME Shell extension that puts a network icon in the panel. Click it and you
get **every physical network interface** on the machine — wired and wireless,
active or not — each with its MAC address and IP addresses.

```
enp1s0                          Cable unplugged
  00:1a:2b:3c:4d:5e
  No IP address

wlp2s0                          Connected
  00:1a:2b:3c:4d:5f
  192.168.1.42
```

Tested on GNOME Shell 48.7 (Wayland).

## What it shows

- **Every hardware interface, always.** Down interfaces are listed too, so you
  can read a MAC off an unplugged NIC.
- **MAC address** for each interface.
- **IPv4 and IPv6 addresses.** Link-local `fe80::` addresses are filtered out
  as noise.
- **Per-interface state** — Connected, Disconnected, Cable unplugged,
  Connecting, Unmanaged — taken from NetworkManager where it has an opinion,
  otherwise from the kernel's `operstate`.
- **Click to copy.** Clicking an interface puts its IP address (or MAC, if it
  has no IP) on the clipboard and shows a notification.
- **Panel icon reflects the link**: wired, wireless, or offline.
- **Network Settings** entry at the bottom of the menu.

## Requirements

- GNOME Shell 48 or newer.
- NetworkManager — optional. Without it, `ip` from iproute2 is used instead.

## Install

```sh
./install.sh
```

Then load it into the shell:

- **X11** — `Alt+F2`, type `r`, press `Enter`.
- **Wayland** — `./dev-reload.sh` (see [below](#loading-without-logging-out-wayland)),
  or log out and back in.

`install.sh` copies the extension into
`~/.local/share/gnome-shell/extensions/` and enables it. If
`gnome-extensions enable` reports that the extension does not exist, that is
expected on a first install — the running shell has not scanned the directory
yet. It will be enabled the moment the shell sees it.

## Uninstall

```sh
gnome-extensions disable gnome-net-dev-info@eladc.github.io
rm -rf ~/.local/share/gnome-shell/extensions/gnome-net-dev-info@eladc.github.io
```

## How it works

**Which interfaces count as physical.** The list comes from `/sys/class/net/*`,
filtered to entries that have a `device` symlink. That symlink exists only when
the interface is backed by a real driver-bound device, which cleanly excludes
`lo`, `docker0`, `veth*`, bridges, bonds, VPN tunnels and `wg*` without
maintaining a blocklist of name prefixes. Wired interfaces sort before wireless;
`wireless`/`phy80211` in sysfs is what distinguishes the two.

**MAC and up/down** come straight from sysfs (`address`, `operstate`) — always
available, no daemon required.

**IP addresses** come from NetworkManager via the `NM` GObject introspection
bindings: `get_ip4_config()` and `get_ip6_config()` on the device matched by
interface name. No polling and no subprocess in the common path.

**The fallback.** NetworkManager reports no addresses for interfaces it does not
manage — a machine running systemd-networkd, or an interface pinned in
`NetworkManager.conf`. When an interface is up but NM offers no addresses, the
extension shells out once to `ip -json addr show`, asynchronously, and merges
the result. The output is cached for the life of the menu.

**Refresh strategy.** The menu is rebuilt on open, which is cheap and always
current. Between openings the panel icon is kept in sync by NetworkManager's
`device-added` / `device-removed` / `notify::primary-connection` signals and by
`Gio.NetworkMonitor`'s `network-changed`. There are no timers.

## Loading without logging out (Wayland)

GNOME Shell does not watch the extensions directory — it scans once at startup —
so a freshly copied extension is invisible to the running shell. Extensions from
extensions.gnome.org load instantly because the browser connector calls the
shell's `InstallRemoteExtension` D-Bus method, which unpacks *and* loads them.
There is no equivalent method for a local directory.

Looking Glass, however, evaluates JavaScript inside the shell process, and
unlike the `org.gnome.Shell.Eval` D-Bus method it is not gated behind
unsafe-mode. So:

```sh
./dev-reload.sh     # prints the right snippet, and copies it if wl-copy/xclip is installed
```

Then `Alt+F2` → type `lg` → `Enter` → **Evaluator** tab → paste. The snippet is
one of:

```js
(async () => {
    const uuid = 'gnome-net-dev-info@eladc.github.io';
    const mgr = Main.extensionManager;
    let ext = mgr.lookup(uuid);
    if (ext)
        await mgr.unloadExtension(ext);
    const dir = Gio.File.new_for_path('/home/YOU/.local/share/gnome-shell/extensions/gnome-net-dev-info@eladc.github.io');
    ext = mgr.createExtensionObject(uuid, dir, 2);
    await mgr.loadExtension(ext);
    print('gnome-net-dev-info loaded, state =', ext.state);
})();
```

`Esc` closes Looking Glass.

`metadata.json` deliberately carries `version-name` and no numeric `version`
field. The shell refuses an in-session reload when `version` changes between
unload and reload — omitting it keeps this workflow working.

**This does not pick up code changes after the first load, and there is no
reliable fix.** Two separate GJS/GObject limits stack up here:

1. **Module cache.** GJS's ES module loader caches a module by URL for the
   lifetime of the shell process. Re-importing the same `extension.js` URI
   silently returns the module from the *first* import — edits on disk are
   invisible, no error.
2. **GObject type registration is permanent and global to the process.** A
   panel indicator is a class run through `GObject.registerClass()`, which
   derives a GType name from the class name and registers it with the
   process-wide GObject type system. There is no unregister API. So even the
   obvious fix for (1) — importing with a cache-busting `?t=<timestamp>` query
   string, which GJS *does* treat as a distinct module URL — fails one level
   deeper: the freshly re-executed module calls `GObject.registerClass()`
   again with the same class name, which throws `Type name Gjs_NetDevInfoIndicator
   is already registered`. Confirmed directly with a throwaway `gjs` script.
   If that throw isn't caught, the extension is left in a broken state (no
   icon, `gnome-extensions info` reports `State: UNKNOWN`) — worse than doing
   nothing.

So in-session reload is good for exactly one thing: getting the extension
running the *first* time after a fresh copy, without a logout. Once you've
edited `extension.js` after that, the options are a real process restart —
log out and back in (Wayland), `Alt+F2` `r` (X11) — or testing in a fresh
[nested shell](#development) instead, which is a new process every time and
has neither limitation.

## Development

```
gnome-net-dev-info@eladc.github.io/
├── extension.js     # indicator, sysfs + NetworkManager plumbing
├── metadata.json
└── stylesheet.css
install.sh           # copy into place and enable
dev-reload.sh        # print the Looking Glass snippet to (re)load it live
```

Iterate with `./install.sh && ./dev-reload.sh`.

Syntax check without touching the shell:

```sh
cp gnome-net-dev-info@eladc.github.io/extension.js /tmp/ext.mjs && node --check /tmp/ext.mjs
```

Verify it loads for real, in a throwaway nested shell that rescans everything on
start:

```sh
dbus-run-session -- gnome-shell --nested --wayland
```

The interface-detection and NetworkManager logic touches no Clutter or St, so it
can be lifted into a standalone script and run under `gjs -m script.js` — much
faster than restarting a shell.

## Packaging for extensions.gnome.org

```sh
gnome-extensions pack --force --extra-source=../LICENSE gnome-net-dev-info@eladc.github.io
```

Only the extension directory goes into the ZIP — `install.sh` and
`dev-reload.sh` are development helpers and the review guidelines ask that build
and install scripts stay out of the submission. `--extra-source` pulls the
licence text in, since the ZIP is what users receive.

## Troubleshooting

```sh
gnome-extensions info gnome-net-dev-info@eladc.github.io   # State: ACTIVE means it is running
journalctl -f -o cat /usr/bin/gnome-shell        # watch for errors while opening the menu
```

`OUT_OF_DATE` means `shell-version` in `metadata.json` does not list your shell's
major version. `ERROR` means something threw — the traceback is in the log above.

## License

GPL-2.0-or-later — see [LICENSE](LICENSE). GNOME Shell itself is
GPL-2.0-or-later, so extensions have to be distributed under compatible terms.
