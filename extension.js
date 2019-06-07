
'use strict';

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const St = imports.gi.St;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();
const Main = imports.ui.main;
const PanelMenu = imports.ui.panelMenu;

const Gvc = imports.gi.Gvc;
const Lang = imports.lang;
const Mainloop = imports.mainloop;
const Meta = imports.gi.Meta;
const Shell = imports.gi.Shell;
const Signals = imports.signals;

const KEYBINDING_KEY_NAME = 'keybinding-toggle-mute';

const Config = imports.misc.config;
const SHELL_MINOR = parseInt(Config.PACKAGE_VERSION.split('.')[1]);

let microphone;

const Microphone = new Lang.Class({
  Name: 'Microphone',

  _init: function() {
    this.active = null;
    this.stream = null;
    this.muted_changed_id = 0;
    this.mixer_control = new Gvc.MixerControl({name: 'Nothing to say'});
    this.mixer_control.open();
    this.mixer_control.connect('default-source-changed', Lang.bind(this, this.refresh));
    this.mixer_control.connect('stream-added', Lang.bind(this, this.refresh));
    this.mixer_control.connect('stream-removed', Lang.bind(this, this.refresh));
    this.refresh();
  },

  refresh: function() {
    // based on gnome-shell volume control
    if (this.stream && this.muted_changed_id) {
      this.stream.disconnect(this.muted_changed_id);
    }
    let was_active = this.active;
    this.active = false;
    this.stream = this.mixer_control.get_default_source();
    if (this.stream) {
      this.muted_changed_id = this.stream.connect(
        'notify::is-muted', Lang.bind(this, this.notify_muted));
      let recording_apps = this.mixer_control.get_source_outputs();
      for (let i = 0; i < recording_apps.length; i++) {
        let output_stream = recording_apps[i];
        let id = output_stream.get_application_id();
        if (!id || (id != 'org.gnome.VolumeControl' && id != 'org.PulseAudio.pavucontrol')) {
          this.active = true;
        }
      }
    }
    this.notify_muted();
    if (this.active != was_active)
        this.emit('notify::active');
  },

  destroy: function() {
      this.mixer_control.close();
  },

  notify_muted: function() {
    this.emit('notify::muted');
  },

  get muted() {
    if (!this.stream)
      return true;
    return this.stream.is_muted;
  },

  set muted(muted) {
    if (!this.stream)
      return;
    this.stream.change_is_muted(muted);
  },

  get level() {
    if (!this.stream)
        return 0;
    return 100 * this.stream.get_volume() / this.mixer_control.get_vol_max_norm();
  }
});
Signals.addSignalMethods(Microphone.prototype);


function get_icon_name(muted) {
  if (muted)
    return 'microphone-sensitivity-muted-symbolic';
  else
    return 'microphone-sensitivity-high-symbolic';
}


function show_osd(text, muted, level) {
  let monitor = -1;
  Main.osdWindowManager.show(
    monitor,
    Gio.Icon.new_for_string(get_icon_name(muted)),
    text,
    level);
}


let mute_timeout_id = 0;


function on_activate(widget, event) {
  if (microphone.muted) {
    microphone.muted = false;
    show_osd(null, false, microphone.level);
  } else {
    // use a delay before muting; this makes push-to-talk work
    if (mute_timeout_id) {
      Mainloop.source_remove(mute_timeout_id);
      show_osd(  // keep osd visible
        null, false, microphone.level);
    }
    mute_timeout_id = Mainloop.timeout_add(
      100,
      function() {
        mute_timeout_id = 0;
        microphone.muted = true;
        show_osd(null, true, 0);
      });
  }
}


function get_settings() {
  let extension = ExtensionUtils.getCurrentExtension();
  let schema_dir = extension.dir.get_child('schemas');
  let schema_source;
  if (schema_dir.query_exists(null))  // local install
    schema_source = Gio.SettingsSchemaSource.new_from_directory(
      schema_dir.get_path(),
      Gio.SettingsSchemaSource.get_default(),
      false);
  else  // global install (same prefix as gnome-shell)
    schema_source = Gio.SettingsSchemaSource.get_default();
  let schema_id = extension.metadata['settings-schema'];
  let schema = schema_source.lookup(schema_id, true);
  if (!schema)
    throw new Error(
      'Schema ' + schema_id + ' could not be found for extension ' +
      extension.metadata.uuid);
  return new Gio.Settings({settings_schema: schema});
}

const settings = get_settings();

var Indicator = class Indicator extends PanelMenu.Button {

  _init() {
      super._init(0.0, `${Me.metadata.name} Indicator`, false);

      let icon = new St.Icon({
          gicon: new Gio.ThemedIcon({name: get_icon_name(false)}),
          style_class: 'system-status-icon'
      });
      this.actor.add_child(icon);
      this.actor.connect('button-press-event', on_activate);
      microphone.connect(
        'notify::muted',
        function () {
          icon.set_gicon(new Gio.ThemedIcon({name: get_icon_name(microphone.muted)}));
        });
    
  }
}

if (SHELL_MINOR > 30) {
  Indicator = GObject.registerClass(
    {GTypeName: 'Indicator'},
    Indicator
  );
}

function init() {
}

let panel_button, panel_icon;
let initialised = false;  // flag to avoid notifications on startup
let indicator = null;

function enable() {
  microphone = new Microphone();
  microphone.connect(
    'notify::active',
    function() {
      if (initialised || microphone.active)
        show_osd(
          microphone.active ? "Microphone activated" : "Microphone deactivated",
          microphone.muted);
      initialised = true;
    });
  indicator = new Indicator();
  Main.panel.addToStatusArea(`${Me.metadata.name} Indicator`, indicator);  
  Main.wm.addKeybinding(
    KEYBINDING_KEY_NAME,
    settings,
    Meta.KeyBindingFlags.NONE,
    Shell.ActionMode.ALL,
    on_activate);
}

function disable() {
  Main.wm.removeKeybinding(KEYBINDING_KEY_NAME);
  if (indicator !== null) {
    indicator.destroy();
    indicator = null;
  }  
  microphone.destroy();
  microphone = null;
}
