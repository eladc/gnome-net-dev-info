/* extension.js
 *
 * Net Device Info - lists every physical network interface with its MAC and
 * IP addresses in the GNOME Shell panel.
 *
 * Copyright (C) 2026 eladc <eladco@gmail.com>
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 *
 * This program is free software: you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the Free
 * Software Foundation, either version 2 of the License, or (at your option)
 * any later version. See the LICENSE file for the full text.
 */

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import NM from 'gi://NM';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

const SYS_NET = '/sys/class/net';

/* ------------------------------------------------------------------ *
 * sysfs helpers - the authoritative list of physical interfaces
 * ------------------------------------------------------------------ */

function readSysAttr(iface, attr) {
    try {
        const [ok, bytes] = GLib.file_get_contents(`${SYS_NET}/${iface}/${attr}`);
        if (!ok)
            return null;
        return new TextDecoder().decode(bytes).trim();
    } catch {
        return null;
    }
}

/** Interfaces backed by real hardware: they have a `device` symlink in sysfs.
 *  This filters out lo, bridges, docker0, veth, tun/tap, wireguard, etc. */
function listPhysicalInterfaces() {
    const names = [];
    let iter;
    try {
        iter = Gio.File.new_for_path(SYS_NET).enumerate_children(
            'standard::name', Gio.FileQueryInfoFlags.NONE, null);
    } catch {
        return names;
    }

    let info;
    while ((info = iter.next_file(null)) !== null) {
        const name = info.get_name();
        if (name === 'lo')
            continue;
        if (!GLib.file_test(`${SYS_NET}/${name}/device`, GLib.FileTest.EXISTS))
            continue;
        names.push(name);
    }
    iter.close(null);

    // Wired first, then wireless, alphabetically within each group.
    names.sort((a, b) => {
        const wa = isWireless(a) ? 1 : 0;
        const wb = isWireless(b) ? 1 : 0;
        return wa !== wb ? wa - wb : a.localeCompare(b);
    });
    return names;
}

function isWireless(iface) {
    return GLib.file_test(`${SYS_NET}/${iface}/wireless`, GLib.FileTest.EXISTS) ||
           GLib.file_test(`${SYS_NET}/${iface}/phy80211`, GLib.FileTest.EXISTS);
}

function operState(iface) {
    return readSysAttr(iface, 'operstate') ?? 'unknown';
}

function macAddress(iface) {
    const mac = readSysAttr(iface, 'address');
    return mac && mac !== '00:00:00:00:00:00' ? mac : null;
}

/* ------------------------------------------------------------------ *
 * NetworkManager helpers
 * ------------------------------------------------------------------ */

function nmStateLabel(state) {
    switch (state) {
    case NM.DeviceState.ACTIVATED:
        return _('Connected');
    case NM.DeviceState.DISCONNECTED:
        return _('Disconnected');
    case NM.DeviceState.UNMANAGED:
        return _('Unmanaged');
    case NM.DeviceState.UNAVAILABLE:
        return _('Cable unplugged');
    case NM.DeviceState.FAILED:
        return _('Failed');
    case NM.DeviceState.DEACTIVATING:
        return _('Disconnecting');
    case NM.DeviceState.PREPARE:
    case NM.DeviceState.CONFIG:
    case NM.DeviceState.NEED_AUTH:
    case NM.DeviceState.IP_CONFIG:
    case NM.DeviceState.IP_CHECK:
    case NM.DeviceState.SECONDARIES:
        return _('Connecting');
    default:
        return null;
    }
}

function nmAddresses(device) {
    const v4 = [];
    const v6 = [];
    if (!device)
        return {v4, v6};

    const ip4 = device.get_ip4_config();
    if (ip4) {
        for (const addr of ip4.get_addresses())
            v4.push(addr.get_address());
    }

    const ip6 = device.get_ip6_config();
    if (ip6) {
        for (const addr of ip6.get_addresses()) {
            const a = addr.get_address();
            if (!a.startsWith('fe80:'))  // link-local is noise
                v6.push(a);
        }
    }
    return {v4, v6};
}

/* ------------------------------------------------------------------ *
 * Indicator
 * ------------------------------------------------------------------ */

const NetDevInfoIndicator = GObject.registerClass(
class NetDevInfoIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.5, _('Net Device Info'));

        this._extension = extension;
        this._nmClient = null;
        this._nmHandlers = [];
        this._fallbackIps = null;
        this._fallbackProc = null;
        this._cancellable = new Gio.Cancellable();

        this._icon = new St.Icon({
            icon_name: 'network-transmit-receive-symbolic',
            style_class: 'system-status-icon',
        });
        this.add_child(this._icon);

        this._section = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._section);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const settingsItem = new PopupMenu.PopupMenuItem(_('Network Settings'));
        settingsItem.connect('activate', () => this._openNetworkSettings());
        this.menu.addMenuItem(settingsItem);

        this.menu.connect('open-state-changed', (_menu, isOpen) => {
            if (isOpen)
                this._rebuildMenu();
        });

        this._monitor = Gio.NetworkMonitor.get_default();
        this._monitorId = this._monitor.connect('network-changed',
            () => this._onNetworkChanged());

        this._initNmClient();
        this._rebuildMenu();
    }

    _initNmClient() {
        NM.Client.new_async(this._cancellable, (_obj, res) => {
            try {
                this._nmClient = NM.Client.new_finish(res);
            } catch (e) {
                if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    console.debug(`Net Device Info: NetworkManager unavailable: ${e.message}`);
                return;
            }

            for (const signal of ['device-added', 'device-removed',
                'notify::primary-connection', 'notify::active-connections']) {
                this._nmHandlers.push(
                    this._nmClient.connect(signal, () => this._onNetworkChanged()));
            }
            this._onNetworkChanged();
        });
    }

    _nmDeviceFor(iface) {
        if (!this._nmClient)
            return null;
        try {
            return this._nmClient.get_device_by_iface(iface);
        } catch {
            return null;
        }
    }

    _onNetworkChanged() {
        if (this.menu.isOpen)
            this._rebuildMenu();
    }

    /* --- menu ---------------------------------------------------- */

    _rebuildMenu() {
        this._section.removeAll();

        const interfaces = listPhysicalInterfaces();
        if (interfaces.length === 0) {
            const empty = new PopupMenu.PopupMenuItem(_('No physical interfaces found'));
            empty.setSensitive(false);
            this._section.addMenuItem(empty);
            return;
        }

        let needsFallback = false;
        let first = true;

        for (const iface of interfaces) {
            if (!first)
                this._section.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            first = false;

            const device = this._nmDeviceFor(iface);
            const state = operState(iface);
            const up = state === 'up';
            let {v4, v6} = nmAddresses(device);

            // NetworkManager knows nothing about unmanaged interfaces (e.g.
            // ones driven by systemd-networkd), so fall back to `ip addr`.
            if (v4.length === 0 && v6.length === 0 && up) {
                const cached = this._fallbackIps?.get(iface);
                if (cached) {
                    v4 = cached.v4;
                    v6 = cached.v6;
                } else {
                    needsFallback = true;
                }
            }

            this._section.addMenuItem(this._buildInterfaceItem({
                iface,
                up,
                mac: macAddress(iface),
                label: nmStateLabel(device?.get_state()) ??
                       (up ? _('Up') : _('Down')),
                v4,
                v6,
            }));
        }

        if (needsFallback)
            this._fetchFallbackIps();
    }

    _buildInterfaceItem(info) {
        const item = new PopupMenu.PopupBaseMenuItem({style_class: 'gnome-net-dev-info-item'});

        const box = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });

        const header = new St.BoxLayout({x_expand: true});
        header.add_child(new St.Icon({
            icon_name: isWireless(info.iface)
                ? 'network-wireless-symbolic' : 'network-wired-symbolic',
            style_class: 'popup-menu-icon',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        header.add_child(new St.Label({
            text: info.iface,
            style_class: 'gnome-net-dev-info-iface',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        header.add_child(new St.Label({
            text: info.label,
            style_class: `gnome-net-dev-info-state ${info.up ? 'gnome-net-dev-info-up' : 'gnome-net-dev-info-down'}`,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        box.add_child(header);

        const details = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'gnome-net-dev-info-details',
        });

        if (info.mac)
            details.add_child(new St.Label({text: info.mac, style_class: 'gnome-net-dev-info-mac'}));

        for (const ip of info.v4)
            details.add_child(new St.Label({text: ip, style_class: 'gnome-net-dev-info-addr'}));
        for (const ip of info.v6)
            details.add_child(new St.Label({text: ip, style_class: 'gnome-net-dev-info-addr gnome-net-dev-info-addr6'}));

        if (info.v4.length === 0 && info.v6.length === 0) {
            details.add_child(new St.Label({
                text: _('No IP address'),
                style_class: 'gnome-net-dev-info-empty',
            }));
        }

        box.add_child(details);
        item.add_child(box);

        const copyable = info.v4[0] ?? info.v6[0] ?? info.mac;
        if (copyable) {
            item.connect('activate', () => {
                St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, copyable);
                Main.notify(_('Net Device Info'), `${_('Copied to clipboard')}: ${copyable}`);
            });
        } else {
            item.setSensitive(false);
        }

        return item;
    }

    /* --- `ip addr` fallback -------------------------------------- */

    _fetchFallbackIps() {
        if (this._fallbackProc)
            return;

        try {
            this._fallbackProc = Gio.Subprocess.new(['ip', '-json', 'addr', 'show'],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch (e) {
            console.debug(`Net Device Info: cannot run ip(8): ${e.message}`);
            return;
        }

        this._fallbackProc.communicate_utf8_async(null, this._cancellable, (source, res) => {
            this._fallbackProc = null;
            let stdout;
            try {
                [, stdout] = source.communicate_utf8_finish(res);
            } catch (e) {
                if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    console.debug(`Net Device Info: ip(8) failed: ${e.message}`);
                return;
            }

            const map = new Map();
            try {
                for (const entry of JSON.parse(stdout)) {
                    const v4 = [];
                    const v6 = [];
                    for (const addr of entry.addr_info ?? []) {
                        if (addr.family === 'inet')
                            v4.push(addr.local);
                        else if (addr.family === 'inet6' && addr.scope !== 'link')
                            v6.push(addr.local);
                    }
                    map.set(entry.ifname, {v4, v6});
                }
            } catch (e) {
                console.debug(`Net Device Info: cannot parse ip(8) output: ${e.message}`);
                return;
            }

            this._fallbackIps = map;
            if (this.menu.isOpen)
                this._rebuildMenu();
        });
    }

    /** Activate the Settings app's network panel the same way GNOME Shell's own
     *  network menu does - no binary is spawned. */
    _openNetworkSettings() {
        const app = Shell.AppSystem.get_default()
            .lookup_app('org.gnome.Settings.desktop');
        if (!app) {
            console.debug('Net Device Info: GNOME Settings is not installed');
            return;
        }

        const param = new GLib.Variant('av',
            [new GLib.Variant('(sav)', ['network', []])]);
        app.activate_action('launch-panel', param, 0, -1, null).catch(
            e => console.debug(`Net Device Info: cannot open Settings: ${e.message}`));
    }

    destroy() {
        this._cancellable?.cancel();
        this._cancellable = null;

        // Cancelling the read above leaves ip(8) running; make it exit now.
        this._fallbackProc?.force_exit();
        this._fallbackProc = null;

        if (this._monitorId) {
            this._monitor.disconnect(this._monitorId);
            this._monitorId = 0;
        }
        this._monitor = null;

        for (const id of this._nmHandlers)
            this._nmClient?.disconnect(id);
        this._nmHandlers = [];
        this._nmClient = null;

        this._fallbackIps = null;
        this._extension = null;

        super.destroy();
    }
});

export default class NetDevInfoExtension extends Extension {
    enable() {
        this._indicator = new NetDevInfoIndicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
