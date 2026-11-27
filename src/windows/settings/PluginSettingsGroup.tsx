import { Fragment, useState, type ReactNode } from "react";
import { ShieldCheck } from "lucide-react";
import { SettingsGroup } from "../../components/settings/SettingsGroup";
import { SettingsLinkButton } from "../../components/settings/SettingsLinkButton";
import { SettingsRow } from "../../components/settings/SettingsRow";
import { PluginIcon } from "../../features/plugins/PluginIcon";
import { PluginSettingRow } from "../../features/plugins/PluginSettingRow";
import { runPluginAction, setPluginSetting, type InstalledPlugin, type PluginManifest } from "../../features/plugins/api";
import { pluginFailureCode, pluginFailureDetail } from "../../features/plugins/errors";
import type { NativePluginId } from "../../features/plugins/native/catalog";
import { pluginsOnPage, type PlacedPlugin, type PluginPageCategory } from "../../features/plugins/placement.ts";
import { refreshPlugins, usePlugins } from "../../features/plugins/usePlugins";
import { usePlacedPlugins, usePluginName } from "../../features/plugins/usePlacedPlugins";
import { useLocale, useTranslation } from "../../i18n";
import "./PluginSettingsGroup.css";

/** Where a group's own message belongs once settings and actions are shown as separate cards. */
type Feedback = { scope: "settings" | "actions"; error: boolean; text: string };

/** Who a standalone page belongs to: its mark, what it does, and whether it is running. */
function PluginIntro({ manifest, name, status, anchor }: { manifest: PluginManifest; name: string; status: string; anchor: string }) {
  const t = useTranslation().settings.plugins;
  const { locale } = useLocale();
  return <section className="plugin-group__intro" data-plugin-group={anchor}>
    <span className="plugin-group__intro-icon" aria-hidden="true"><PluginIcon id={manifest.id} icon={manifest.icon} size={30} /></span>
    <div className="plugin-group__intro-text">
      <span className="plugin-group__intro-name">{name}</span>
      <p className="plugin-group__intro-description">{manifest.description[locale]}</p>
    </div>
    <div className="plugin-group__intro-meta">
      <span className={`plugin-group__status plugin-group__status--${status}`}>
        <span className="plugin-group__status-dot" aria-hidden="true" />{t.status[status] ?? status}
      </span>
      <span className="plugin-group__version">v{manifest.version}</span>
    </div>
  </section>;
}

/** Permissions say what a plugin can reach; on the plugin's own page they stay out of the way. */
function PluginPermissions({ permissions }: { permissions: string[] }) {
  const t = useTranslation().settings.plugins;
  return <details className="plugin-group__permission-details">
    <summary><ShieldCheck size={14} aria-hidden="true" />{t.permissions}</summary>
    <div className="plugin-group__permissions">{permissions.map((permission) =>
      <span key={permission} className="plugin-group__permission">{t.permission[permission] ?? permission}</span>)}</div>
  </details>;
}

/**
 * A packaged plugin's group on the page its settings were declared for: the settings and the
 * action buttons that belong on this page, then its version, state and permissions. A standalone
 * page leads with the plugin's identity and keeps its actions apart from its settings.
 */
export function ExternalPluginGroup({ plugin, external, page }: { plugin: PlacedPlugin; external: InstalledPlugin; page: PluginPageCategory }) {
  const t = useTranslation().settings.plugins;
  const { locale } = useLocale();
  const { live } = usePlugins();
  const name = usePluginName()(plugin);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const { manifest } = external;
  const home = plugin.category === page;
  // A plugin with its own island page offers its actions there.
  const actions = plugin.actionsCategory === page && !manifest.contributes.includes("panel") ? manifest.actions : [];
  const settings = home ? manifest.settings : [];
  // A group that would only repeat the version belongs to the plugin's main page.
  if (!home && actions.length === 0) return null;
  const status = live[plugin.id]?.status ?? "stopped";
  const perform = async (action: () => Promise<unknown>, block: boolean, scope: Feedback["scope"], done?: string) => {
    if (block) setBusy(true);
    setFeedback(null);
    try { await action(); await refreshPlugins(); if (done) setFeedback({ scope, error: false, text: done }); }
    catch (failure) {
      const code = pluginFailureCode(failure);
      setFeedback({ scope, error: true, text: code ? t.market.failure[code] : pluginFailureDetail(failure) ?? t.market.operationFailed(name) });
    }
    finally { if (block) setBusy(false); }
  };
  const feedbackNode = (scope?: Feedback["scope"]) => feedback && (scope === undefined || feedback.scope === scope)
    ? <span className="plugins-settings__error" role={feedback.error ? "alert" : "status"}>{feedback.text}</span>
    : undefined;
  const settingsRows = settings.map((setting) => <PluginSettingRow
    key={`${plugin.id}/${setting.key}/${setting.type === "number" ? "number" : JSON.stringify(external.settings[setting.key])}`}
    setting={setting} value={external.settings[setting.key] ?? setting.default} disabled={busy}
    onSave={(value) => { void perform(() => setPluginSetting(plugin.id, setting.key, value), setting.type !== "number", "settings"); }} />);
  const actionRows = actions.map((action) => <SettingsRow key={action.id} title={action.label[locale]} control={
    <SettingsLinkButton disabled={busy} ariaLabel={action.label[locale]}
      onClick={() => { void perform(() => runPluginAction(plugin.id, action.id), true, "actions", t.actionDone); }}>{t.runAction}</SettingsLinkButton>} />);
  // The page title already names a standalone plugin, so it opens with the plugin's identity
  // instead of repeating the name, and its actions sit in a card of their own.
  if (plugin.standalone) return <>
    <PluginIntro manifest={manifest} name={name} status={status} anchor={plugin.id} />
    {settingsRows.length > 0 && <SettingsGroup footer={feedbackNode("settings")}>{settingsRows}</SettingsGroup>}
    {actionRows.length > 0 && <SettingsGroup title={t.actions} footer={feedbackNode("actions")}>{actionRows}</SettingsGroup>}
    {manifest.permissions.length > 0 && <PluginPermissions permissions={manifest.permissions} />}
  </>;
  return <SettingsGroup anchor={plugin.id} title={name}
    icon={<PluginIcon id={plugin.id} size={16} panelIcon={manifest.panel?.icon} />} footer={feedbackNode()}>
    {settingsRows}
    {actionRows}
    {home && <SettingsRow description={`${manifest.version} · ${t.status[status] ?? ""}`}
      title={<span className="plugin-group__permissions"><ShieldCheck size={14} aria-hidden="true" />{t.permissions}</span>}>
      <div className="plugin-group__permissions">{manifest.permissions.map((permission) =>
        <span key={permission} className="plugin-group__permission">{t.permission[permission] ?? permission}</span>)}</div>
    </SettingsRow>}
  </SettingsGroup>;
}

/**
 * The groups of the plugins that declared this page, in catalog order and after the page's own
 * groups. Built-in plugins have no manifest, so the page that hosts them draws their group.
 */
export function PluginPageGroups({ page, renderNative }: {
  page: PluginPageCategory;
  renderNative?: (id: NativePluginId) => ReactNode;
}) {
  const placed = usePlacedPlugins();
  return <>{pluginsOnPage(placed, page).map((plugin) => plugin.external
    ? <ExternalPluginGroup key={plugin.id} plugin={plugin} external={plugin.external} page={page} />
    : <Fragment key={plugin.id}>{renderNative?.(plugin.native)}</Fragment>)}</>;
}
