import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { SettingsRow } from "../../components/settings/SettingsRow";
import { SettingsToggleRow } from "../../components/settings/SettingsToggleRow";
import { SettingsInput } from "../../components/settings/SettingsInput";
import { SettingsSelect } from "../../components/settings/SettingsSelect";
import { SettingsLinkButton } from "../../components/settings/SettingsLinkButton";
import { useLocale, useTranslation } from "../../i18n";
import type { PluginSetting } from "./api";
import { PluginNumberSettingRow } from "./PluginNumberSettingRow";
import "./PluginSettingRow.css";

export function PluginSettingRow({ setting, value, configured = false, disabled, onSave }: {
  setting: PluginSetting;
  value: boolean | string;
  /** Every secret of this plugin is stored; the host never sends the values themselves. */
  configured?: boolean;
  disabled: boolean;
  onSave: (value: boolean | string) => void;
}) {
  const { locale } = useLocale();
  const t = useTranslation().settings.plugins;
  const [draft, setDraft] = useState(String(value));
  const title = setting.label[locale];
  // The manifest explains its own settings; the host reads that line instead of a per-plugin string.
  const description = setting.description?.[locale];
  if (setting.type === "number") return <PluginNumberSettingRow title={title} description={description} value={String(value)} min={setting.min ?? 0} max={setting.max ?? 0} disabled={disabled} onSave={onSave} />;
  if (setting.type === "toggle") return <SettingsToggleRow title={title} description={description} checked={value === true} disabled={disabled} onChange={onSave} />;
  if (setting.type === "select") return <SettingsRow title={title} description={description} control={<SettingsSelect value={String(value)} options={setting.options.map((o) => ({ value: o.value, label: o.label[locale] }))} ariaLabel={title} disabled={disabled} onChange={onSave} />} />;
  if (setting.type === "secret") return <PluginSecretRow title={title} description={description} configured={configured} disabled={disabled} onSave={onSave} />;
  return <SettingsRow title={title} description={description} control={<SettingsLinkButton disabled={disabled || draft === String(value)} onClick={() => onSave(draft)}>{t.save}</SettingsLinkButton>}>
    <SettingsInput aria-label={title} type="text" autoComplete="off" value={draft} disabled={disabled} onChange={(event) => setDraft(event.target.value)} />
  </SettingsRow>;
}

/**
 * A secret field. The host keeps the value in the OS credential store and only tells us whether
 * every secret of the plugin is set, so a stored value can never be written back here: a saved
 * row shows a mask instead, and the eye only reveals what is being typed. Saving an empty draft
 * stores nothing, so removing a stored secret is the explicit Clear button.
 */
function PluginSecretRow({ title, description, configured, disabled, onSave }: {
  title: string;
  description?: string;
  configured: boolean;
  disabled: boolean;
  onSave: (value: boolean | string) => void;
}) {
  const t = useTranslation().settings.plugins;
  const [draft, setDraft] = useState("");
  const [revealed, setRevealed] = useState(false);
  const saved = configured && draft === "";
  const reset = () => { setDraft(""); setRevealed(false); };
  return <SettingsRow title={title} description={description} control={<>
    {configured && <SettingsLinkButton tone="danger" disabled={disabled} onClick={() => { onSave(""); reset(); }}>{t.clear}</SettingsLinkButton>}
    <SettingsLinkButton disabled={disabled || draft.trim() === ""} onClick={() => { onSave(draft); reset(); }}>{t.save}</SettingsLinkButton>
  </>}>
    <div className="plugin-secret__field">
      <SettingsInput
        aria-label={title}
        type={revealed ? "text" : "password"}
        autoComplete="off"
        title={saved ? t.saved : undefined}
        value={draft}
        disabled={disabled}
        placeholder={saved ? "••••••••" : t.secret}
        onChange={(event) => setDraft(event.target.value)}
      />
      <button
        type="button"
        className="plugin-secret__visibility"
        disabled={disabled}
        aria-label={revealed ? t.hide : t.show}
        title={revealed ? t.hide : t.show}
        onClick={() => setRevealed((current) => !current)}
      >
        {revealed ? <EyeOff size={15} aria-hidden="true" /> : <Eye size={15} aria-hidden="true" />}
      </button>
    </div>
  </SettingsRow>;
}
