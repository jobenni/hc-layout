// The layout's own settings, opened as a dialog from the tab bar's gear.
// Sections on the left: Workspaces (groups of spaces above the Spaces list) and Mise à jour.
// Workspaces live in shared("benni.workspaces") = { enabled, list: [{ id, name }], of: { spaceId: workspaceId } },
// which benni-spaces reads; a space with no workspace (or a deleted one's) is in the default one.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { spaces, props, closeOverlay, theme, shared, setShared, exec, readTextFile, appHome, checking, notify } from "herdr";

// The layout's update check, repeated in benni-spaces and benni-settings (Herdr refuses imports between mods).
// install.sh records the commit it installed in <appHome>/hc-layout.json; shared("benni.update") = { installed, latest }.
const LAYOUT_REPO = "https://github.com/jobenni/hc-layout.git";
const LAYOUT_BRANCH = "main";
const UPDATE_KEY = "benni.update";

async function readInstalledCommit() {
  const text = await readTextFile(`${appHome()}/hc-layout.json`);
  try { return JSON.parse(text ?? "")?.commit || null; } catch { return null; }
}

async function readLatestCommit() {
  const result = await exec("git", ["ls-remote", LAYOUT_REPO, `refs/heads/${LAYOUT_BRANCH}`], { timeout: 20000 });
  const commit = result.code === 0 ? result.stdout.split(/\s/)[0] : "";
  if (!commit) throw new Error(result.stderr.trim() || "GitHub ne répond pas");
  return commit;
}

const WORKSPACES_KEY = "benni.workspaces";
const DEFAULT_WORKSPACE = { id: "default", name: "Default" };
const SECTIONS = [
  { id: "workspaces", label: "Workspaces", icon: "mods/workspace-chrome/layers.svg" },
  { id: "update", label: "Mise à jour", icon: "mods/git-graph/icons/refresh.svg" },
];

const INSTALL_FROM_GITHUB = [
  'set -e',
  'source=$(mktemp -d)',
  'trap \'rm -rf "$source"\' EXIT',
  'git clone --depth 1 --quiet --branch "$2" "$1" "$source"',
  'HERDR_APP_HOME="$3" bash "$source/install.sh"',
].join("\n");

const shortCommit = (commit) => commit ? commit.slice(0, 7) : "inconnue";

function readWorkspaces() {
  const stored = shared(WORKSPACES_KEY) ?? {};
  const list = Array.isArray(stored.list) ? stored.list.filter((w) => w?.id && typeof w.name === "string") : [];
  if (!list.some((w) => w.id === DEFAULT_WORKSPACE.id)) list.unshift({ ...DEFAULT_WORKSPACE });
  const of = stored.of && typeof stored.of === "object" && !Array.isArray(stored.of) ? stored.of : {};
  return { enabled: stored.enabled === true, list, of };
}

const writeWorkspaces = (store) => setShared(WORKSPACES_KEY, store);

function newWorkspaceId(list) {
  for (let n = 1; ; n++) if (!list.some((w) => w.id === `ws${n}`)) return `ws${n}`;
}

function workspaceOfSpace(store, spaceId) {
  const id = store.of[spaceId];
  return store.list.some((w) => w.id === id) ? id : DEFAULT_WORKSPACE.id;
}

export default class Settings extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    const lastCheck = shared(UPDATE_KEY);
    this.section = lastCheck?.installed && lastCheck.latest && lastCheck.installed !== lastCheck.latest ? "update" : SECTIONS[0].id;
    this.renaming = null; // workspace id whose name is being edited
    this.deleting = null; // workspace id waiting for its confirmation
    this.addInput = InputState.new({ placeholder: "Nouveau workspace (ex. Perso)" });
    this.addInput.on("submit", (_e, cx) => this.addWorkspace(cx));
    this.renameInput = InputState.new({});
    this.renameInput.on("submit", (_e, cx) => this.finishRename(cx));
    this.update = { phase: "checking", installed: null, latest: null, error: "" };
    this.handle.focus();
    if (!checking()) this.checkForUpdate(cx);
  }

  // phase: checking, current, outdated, unknown (no record of the installed commit), error, installing, failed.
  checkForUpdate(cx) {
    this.update = { ...this.update, phase: "checking", error: "" };
    cx.spawn(async (cx) => {
      try {
        const [installed, latest] = await Promise.all([readInstalledCommit(), readLatestCommit()]);
        const phase = !installed ? "unknown" : installed === latest ? "current" : "outdated";
        this.update = { phase, installed, latest, error: "" };
        setShared(UPDATE_KEY, { installed, latest });
      } catch (error) {
        this.update = { ...this.update, phase: "error", error: String(error?.message ?? error) };
      }
      cx.notify();
    });
  }

  // install.sh replaces this mod too, so Herdr may reload the dialog before the result shows.
  installUpdate(cx) {
    this.update = { ...this.update, phase: "installing", error: "" };
    cx.notify();
    cx.spawn(async (cx) => {
      const result = await exec("bash", ["-c", INSTALL_FROM_GITHUB, "bash", LAYOUT_REPO, LAYOUT_BRANCH, appHome()], { timeout: 300000 })
        .catch((error) => ({ code: -1, stdout: "", stderr: String(error?.message ?? error) }));
      if (result.code === 0) {
        notify({ title: "Layout mis à jour", body: `Version ${shortCommit(this.update.latest)} installée.`, level: "success" });
        this.update = { ...this.update, phase: "current", installed: this.update.latest };
        setShared(UPDATE_KEY, { installed: this.update.latest, latest: this.update.latest });
      } else {
        const lastLines = (result.stderr || result.stdout).trim().split("\n").slice(-4).join("\n");
        this.update = { ...this.update, phase: "failed", error: lastLines || `install.sh a échoué (code ${result.code})` };
      }
      cx.notify();
    });
  }

  addWorkspace(cx) {
    const name = this.addInput.value().trim();
    if (!name) return;
    const store = readWorkspaces();
    store.list.push({ id: newWorkspaceId(store.list), name });
    writeWorkspaces(store);
    this.addInput.set_value("");
    cx.notify();
  }

  startRename(w, cx) {
    this.renaming = w.id;
    this.deleting = null;
    this.renameInput.set_value(w.name);
    this.renameInput.set_selected_range({ start: 0, end: w.name.length });
    this.renameInput.focus();
    cx.notify();
  }

  finishRename(cx) {
    const name = this.renameInput.value().trim();
    const store = readWorkspaces();
    const w = store.list.find((k) => k.id === this.renaming);
    if (w && name && name !== w.name) {
      w.name = name;
      writeWorkspaces(store);
    }
    this.renaming = null;
    this.handle.focus();
    cx.notify();
  }

  // Its spaces go back to the default workspace (readWorkspaces recreates it if it's gone).
  deleteWorkspace(id, cx) {
    const store = readWorkspaces();
    store.list = store.list.filter((w) => w.id !== id);
    for (const [space, ws] of Object.entries(store.of)) if (ws === id) delete store.of[space];
    writeWorkspaces(store);
    this.deleting = null;
    cx.notify();
  }

  moveWorkspace(id, by, cx) {
    const store = readWorkspaces();
    const from = store.list.findIndex((w) => w.id === id);
    const to = from + by;
    if (from < 0 || to < 0 || to >= store.list.length) return;
    store.list.splice(to, 0, store.list.splice(from, 1)[0]);
    writeWorkspaces(store);
    cx.notify();
  }

  setEnabled(enabled, cx) {
    writeWorkspaces({ ...readWorkspaces(), enabled });
    cx.notify();
  }

  key(e, cx) {
    if (e.key !== "escape") return;
    if (this.renaming) { this.renaming = null; this.handle.focus(); }
    else if (this.deleting) this.deleting = null;
    else closeOverlay(props().overlay);
    cx.stop_propagation();
    cx.notify();
  }

  iconButton(id, icon, tooltip, t, action, { disabled = false, danger = false } = {}) {
    return h_flex().id(id).size(26).flex_none().items_center().justify_center().rounded(6)
      .text_color(disabled ? t.dim + "66" : t.dim).tooltip(tooltip)
      .when(!disabled, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover).text_color(danger ? t.blocked : t.foreground)).on_click(action))
      .child(typeof icon === "string" && icon.endsWith(".svg") ? svg(icon).size(14) : icon);
  }

  textButton(id, label, primary, t, action) {
    return h_flex().id(id).h(28).px(12).flex_none().items_center().rounded(7).border_1()
      .border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
      .text_color(primary ? t.solid_foreground : t.foreground).text_size(12).font_medium()
      .cursor_pointer().hover((s) => s.opacity(0.88)).on_click(action).child(label);
  }

  toggle(id, on, t, action) {
    return h_flex().id(id).w(34).h(20).p(2).flex_none().rounded(10).cursor_pointer()
      .bg(on ? t.accent : t.input).when(on, (el) => el.justify_end())
      .on_click(action)
      .child(div().size(16).rounded(8).bg("#ffffff"));
  }

  workspaceRow(w, index, store, counts, t) {
    const isDefault = w.id === DEFAULT_WORKSPACE.id;
    const count = counts.get(w.id) ?? 0;
    const row = h_flex().id(`ws-${w.id}`).h(38).px(10).gap(8).items_center().rounded(8).border_1().border_color(t.border).bg(t.surface);
    if (this.deleting === w.id) {
      const where = store.list.find((k) => k.id === DEFAULT_WORKSPACE.id)?.name ?? DEFAULT_WORKSPACE.name;
      const detail = count ? `Ses ${count} space${count > 1 ? "s" : ""} iront dans « ${where} ».` : "Il ne contient aucun space.";
      return row.border_color(t.blocked + "66").bg(t.blocked + "12")
        .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(t.foreground).child(`Supprimer « ${w.name} » ? ${detail}`))
        .child(this.textButton(`ws-delete-cancel-${w.id}`, "Annuler", false, t, (_e, cx) => { this.deleting = null; cx.notify(); }))
        .child(this.textButton(`ws-delete-yes-${w.id}`, "Supprimer", true, t, (_e, cx) => this.deleteWorkspace(w.id, cx)));
    }
    const name = this.renaming === w.id
      ? Input.new(this.renameInput).flex_1().h(28).px(8).rounded(6).border_1().border_color(t.accent).bg(t.background).text_size(12.5).text_color(t.foreground)
      : div().id(`ws-name-${w.id}`).flex_1().min_w(0).truncate().text_size(13).text_color(t.foreground).cursor_pointer()
        .on_click((e, cx) => { if (e.click_count === 2) this.startRename(w, cx); }).child(w.name);
    return row
      .child(name)
      .when(isDefault, (el) => el.child(div().flex_none().px(6).h(18).rounded(4).bg(t.raised).text_size(10.5).text_color(t.muted).flex().items_center().child("par défaut")))
      .child(div().flex_none().w(64).text_size(11.5).text_color(t.dim).child(`${count} space${count > 1 ? "s" : ""}`))
      .child(this.iconButton(`ws-up-${w.id}`, "↑", "Monter", t, (_e, cx) => this.moveWorkspace(w.id, -1, cx), { disabled: index === 0 }))
      .child(this.iconButton(`ws-down-${w.id}`, "↓", "Descendre", t, (_e, cx) => this.moveWorkspace(w.id, 1, cx), { disabled: index === store.list.length - 1 }))
      .child(this.renaming === w.id
        ? this.iconButton(`ws-rename-ok-${w.id}`, "✓", "Valider", t, (_e, cx) => this.finishRename(cx))
        : this.iconButton(`ws-rename-${w.id}`, "✎", "Renommer", t, (_e, cx) => this.startRename(w, cx)))
      .child(this.iconButton(`ws-delete-${w.id}`, "mods/git-graph/icons/trash.svg",
        isDefault ? "Le workspace par défaut accueille les spaces sans workspace : il ne se supprime pas" : "Supprimer",
        t, (_e, cx) => { this.deleting = w.id; this.renaming = null; cx.notify(); }, { disabled: isDefault, danger: true }));
  }

  workspacesSection(t) {
    const store = readWorkspaces();
    const counts = new Map();
    for (const s of spaces()) {
      const ws = workspaceOfSpace(store, s.id);
      counts.set(ws, (counts.get(ws) ?? 0) + 1);
    }
    return v_flex().gap(14)
      .child(h_flex().gap(12).items_center()
        .child(v_flex().flex_1().min_w(0).gap(3)
          .child(div().text_size(13).font_medium().text_color(t.foreground).child("Utiliser les workspaces"))
          .child(div().w_full().text_size(11.5).text_color(t.muted).child("Regroupe les spaces de la barre latérale (travail, perso…). Glisse un space sur un workspace pour l'y ranger.")))
        .child(this.toggle("ws-enabled", store.enabled, t, (_e, cx) => this.setEnabled(!store.enabled, cx))))
      .child(v_flex().gap(6).when(!store.enabled, (el) => el.opacity(0.5))
        .children(store.list.map((w, i) => this.workspaceRow(w, i, store, counts, t))))
      .child(h_flex().gap(8).items_center().when(!store.enabled, (el) => el.opacity(0.5))
        .child(Input.new(this.addInput).flex_1().h(30).px(10).rounded(7).border_1().border_color(t.input).bg(t.background).text_size(12.5).text_color(t.foreground))
        .child(this.textButton("ws-add", "Ajouter", true, t, (_e, cx) => this.addWorkspace(cx))));
  }

  updateSection(t) {
    const { phase, installed, latest, error } = this.update;
    const status = {
      checking: ["Recherche d'une nouvelle version…", t.muted],
      current: ["Le layout est à jour.", t.foreground],
      outdated: ["Une nouvelle version est disponible.", t.accent],
      unknown: ["Version installée inconnue : la mise à jour installera la dernière.", t.foreground],
      error: [`Vérification impossible : ${error}`, t.blocked],
      installing: ["Installation en cours…", t.muted],
      failed: [`Échec de la mise à jour : ${error}`, t.blocked],
    }[phase];
    const canInstall = ["outdated", "unknown", "failed"].includes(phase);
    const canCheck = ["current", "error", "unknown", "outdated", "failed"].includes(phase);
    return v_flex().gap(14)
      .child(div().w_full().text_size(11.5).text_color(t.muted)
        .child(`Compare le layout installé à la branche ${LAYOUT_BRANCH} de ${LAYOUT_REPO.replace("https://", "")}. La mise à jour remplace le layout et ses mods ; les anciennes versions sont gardées dans backups/.`))
      .child(v_flex().gap(4).p(12).rounded(8).border_1().border_color(t.border).bg(t.surface)
        .child(div().text_size(13).font_medium().text_color(status[1]).child(status[0]))
        .child(div().text_size(11.5).text_color(t.dim).child(`Installée : ${shortCommit(installed)} · Dernière : ${shortCommit(latest)}`)))
      .child(h_flex().gap(8)
        .when(canInstall, (el) => el.child(this.textButton("update-install", "Mettre à jour", true, t, (_e, cx) => this.installUpdate(cx))))
        .when(canCheck, (el) => el.child(this.textButton("update-check", "Vérifier", false, t, (_e, cx) => { this.checkForUpdate(cx); cx.notify(); }))));
  }

  render() {
    const t = theme();
    const nav = SECTIONS.map((s) => h_flex().id(`section-${s.id}`).h(30).px(10).gap(8).items_center().rounded(7)
      .text_size(12.5).cursor_pointer()
      .bg(this.section === s.id ? t.selected : t.popover).text_color(this.section === s.id ? t.foreground : t.muted)
      .hover((el) => el.bg(t.hover))
      .on_click((_e, cx) => { this.section = s.id; cx.notify(); })
      .child(svg(s.icon).size(14)).child(div().flex_1().child(s.label))
      .when(s.id === "update" && this.update.phase === "outdated", (el) => el.child(div().size(6).rounded(3).bg(t.accent))));
    const current = SECTIONS.find((s) => s.id === this.section);
    return h_flex().id("settings").track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .size_full().min_h(0).bg(t.popover).text_color(t.foreground)
      .child(v_flex().w(170).flex_none().h_full().p(10).gap(2).border_r_1().border_color(t.border)
        .child(div().px(10).pt(6).pb(10).text_size(11.5).text_color(t.dim).child("Réglages"))
        .children(nav))
      .child(v_flex().flex_1().min_w(0).h_full()
        .child(h_flex().px(20).pt(18).pb(14).items_center()
          .child(div().flex_1().text_size(15).font_semibold().child(current.label))
          .child(this.iconButton("settings-close", "mods/pane/close.svg", "Fermer (Esc)", t, () => closeOverlay(props().overlay))))
        .child(v_flex().id("settings-body").flex_1().min_h(0).px(20).pb(20).overflow_y_scrollbar()
          .when(this.section === "workspaces", (el) => el.child(this.workspacesSection(t)))
          .when(this.section === "update", (el) => el.child(this.updateSection(t)))));
  }
}
