import { div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea, TextView } from "gpui-base";
import { props, theme, closeOverlay, pickFolder, exec, checking, nextCommand, shared } from "herdr";
import { readStore, updateStore, blankRoutine, MODELS, EFFORTS, DEFAULT_KEPT_RUNS } from "./store.js";
import { PRESETS, WEEKDAYS, describeSchedule, scheduleError, scheduleCron, nextRunOf, formatWhen, formatDuration, minuteKey } from "./schedule.js";
import { startRun, purgeOldRuns, focusRunTab, resumeInTab, closeRunTab, cleanWorktree, removeRunFiles } from "./runs.js";
import { workColumnBounds, RUN_TO_SHOW_KEY } from "./scheduler.js";

const SPINNER = "mods/workspace-chrome/spinner.svg";
const CLOCK = "mods/workspace-chrome/clock.svg";
const CLOSE = "mods/pane/close.svg";
const BRANCH = "mods/workspace-chrome/git-branch.svg";
const TRASH = "mods/workspace-chrome/x.svg";
const LIST_WIDTH = 340;
const LAYOUT_CHECK_MS = 1000;
const STATUS_LABEL = { running: "En cours", done: "Terminé", failed: "Échec", missed: "Manqué" };

const statusColor = (t, status) => ({ running: t.working, done: t.ansi2, failed: t.ansi1, missed: t.dim }[status] ?? t.dim);
const firstLine = (text) => (text ?? "").split("\n").map((l) => l.trim()).find(Boolean) ?? "";

/** The Routines screen: over the whole work column, routines on the left, their runs on the right. */
export class RoutinesScreen {
  init(cx) {
    this.handle = cx.focus_handle();
    this.handle.focus();
    const shownRun = readStore().runs.find((r) => r.id === props()?.runId);
    this.filter = null;
    this.expandedRun = shownRun?.print ? shownRun.id : null;
    this.highlightedRun = shownRun?.id ?? null;
    this.editing = null;
    this.confirmingRunDelete = null;
    this.confirmingRoutineDelete = false;
    this.note = null;
    this.formError = "";
    this.busy = new Set();
    this.nameInput = InputState.new({ placeholder: "Revue des dépendances" });
    this.descriptionInput = InputState.new({ placeholder: "Ce que fait la routine (facultatif)" });
    this.promptInput = TextareaState.new({ placeholder: "Le message envoyé à Claude à chaque run", rows: 7 });
    this.timeInput = InputState.new({ placeholder: "09:00" });
    this.minuteInput = InputState.new({ placeholder: "0" });
    this.cronInput = InputState.new({ placeholder: "*/15 9-18 * * 1-5" });
    this.folderInput = InputState.new({ placeholder: "/chemin/du/projet" });
    this.keepInput = InputState.new({ placeholder: String(DEFAULT_KEPT_RUNS) });
    for (const input of [this.timeInput, this.minuteInput, this.cronInput]) input.on("change", (_e, cx) => cx.notify());
    if (checking()) return;
    cx.timer.every(LAYOUT_CHECK_MS, () => this.closeWhenColumnMoved());
    // Shown copies of this mod all hear its commands: the scheduler opens the screen, the screen
    // follows a toast's run and closes on `benni-routines.close`.
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        if (command === "close") { this.close(); return; }
        if (command === "open-run") this.showRun(shared(RUN_TO_SHOW_KEY), cx);
      }
    });
  }

  showRun(runId, cx) {
    const record = readStore().runs.find((r) => r.id === runId);
    if (!record) return;
    this.editing = null;
    this.filter = null;
    this.highlightedRun = record.id;
    if (record.print) this.expandedRun = record.id;
    cx.notify();
  }

  close() {
    closeOverlay(props().overlay);
  }

  // The screen was sized for the window and sidebar it opened over.
  closeWhenColumnMoved() {
    const { viewport, x } = props();
    const now = workColumnBounds();
    if (!viewport) return;
    if (now.viewport.width !== viewport.width || now.viewport.height !== viewport.height || Math.round(now.x) !== Math.round(x)) this.close();
  }

  onKey(event, cx) {
    if (event.key !== "escape") return;
    cx.stop_propagation();
    if (this.confirmingRunDelete || this.confirmingRoutineDelete) {
      this.confirmingRunDelete = null;
      this.confirmingRoutineDelete = false;
    } else if (this.editing) {
      this.editing = null;
      this.handle.focus();
    } else {
      this.close();
    }
    cx.notify();
  }

  // --- Editing ---------------------------------------------------------------------------------

  startEditing(routine, cx) {
    const draft = routine ? JSON.parse(JSON.stringify(routine)) : blankRoutine();
    this.editing = { draft, isNew: !routine };
    this.formError = "";
    this.confirmingRoutineDelete = false;
    this.nameInput.set_value(draft.name);
    this.descriptionInput.set_value(draft.description);
    this.promptInput.set_value(draft.prompt);
    this.timeInput.set_value(draft.schedule.time ?? "09:00");
    this.minuteInput.set_value(String(draft.schedule.minute ?? 0));
    this.cronInput.set_value(draft.schedule.cron ?? "");
    this.folderInput.set_value(draft.folder);
    this.keepInput.set_value(String(draft.keep ?? DEFAULT_KEPT_RUNS));
    this.nameInput.focus();
    cx.notify();
  }

  draftSchedule() {
    const { schedule } = this.editing.draft;
    return {
      ...schedule,
      time: this.timeInput.value().trim(),
      minute: Number(this.minuteInput.value().trim() || 0),
      cron: this.cronInput.value().trim(),
    };
  }

  saveDraft(cx) {
    const draft = this.editing.draft;
    const routine = {
      ...draft,
      name: this.nameInput.value().trim(),
      description: this.descriptionInput.value().trim(),
      prompt: this.promptInput.value().trim(),
      folder: this.folderInput.value().trim().replace(/\/+$/, ""),
      schedule: this.draftSchedule(),
      keep: Math.max(1, Math.floor(Number(this.keepInput.value().trim() || DEFAULT_KEPT_RUNS)) || DEFAULT_KEPT_RUNS),
    };
    if (routine.print) routine.push = false;
    const problem = !routine.name ? "Donne un nom à la routine."
      : !routine.prompt ? "Écris le prompt."
      : !routine.folder ? "Choisis un répertoire."
      : scheduleError(routine.schedule) ? `Planification : ${scheduleError(routine.schedule)}.` : "";
    if (problem) { this.formError = problem; cx.notify(); return; }
    cx.spawn(async (cx) => {
      const exists = (await exec("test", ["-d", routine.folder])).code === 0;
      if (!exists) { this.formError = `Répertoire introuvable : ${routine.folder}`; cx.notify(); return; }
      if (routine.worktree && (await exec("git", ["rev-parse", "--show-toplevel"], { cwd: routine.folder })).code !== 0) {
        this.formError = "Worktree coché, mais ce répertoire n'est pas dans un dépôt git."; cx.notify(); return;
      }
      // A preset keeps its cron too, so "Avancé" opens on the same schedule.
      routine.schedule.cron = scheduleCron(routine.schedule);
      updateStore((store) => {
        const index = store.routines.findIndex((r) => r.id === routine.id);
        if (index >= 0) store.routines[index] = { ...routine, lastFired: store.routines[index].lastFired };
        else store.routines.push(routine);
      });
      this.editing = null;
      this.filter = routine.id;
      this.handle.focus();
      cx.notify();
    });
  }

  deleteRoutine(routineId, cx) {
    updateStore((store) => { store.routines = store.routines.filter((r) => r.id !== routineId); });
    this.editing = null;
    this.confirmingRoutineDelete = false;
    if (this.filter === routineId) this.filter = null;
    this.handle.focus();
    cx.notify();
  }

  chooseFolder(cx) {
    cx.spawn(async (cx) => {
      const folder = await pickFolder({ prompt: "Choisir" });
      if (folder) { this.folderInput.set_value(folder); cx.notify(); }
    });
  }

  // --- Actions on routines and runs -----------------------------------------------------------

  setEnabled(routineId, enabled, cx) {
    updateStore((store) => {
      const routine = store.routines.find((r) => r.id === routineId);
      // Turned back on during a minute it matches: that minute is not run late.
      if (routine) { routine.enabled = enabled; if (enabled) routine.lastFired = minuteKey(new Date()); }
    });
    cx.notify();
  }

  launchNow(routine, cx) {
    if (!routine.enabled || this.busy.has(routine.id)) return;
    this.busy.add(routine.id);
    this.filter = routine.id;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await startRun(routine, { manual: true });
        await purgeOldRuns(routine);
      } catch (error) {
        this.note = { text: `Lancement impossible : ${error?.message ?? error}`, error: true };
      } finally {
        this.busy.delete(routine.id);
        cx.notify();
      }
    });
  }

  openRun(record, cx) {
    if (record.status === "missed") return;
    if (record.print) {
      this.expandedRun = this.expandedRun === record.id ? null : record.id;
      cx.notify();
      return;
    }
    this.goToTab(record, cx);
  }

  goToTab(record, cx) {
    if (focusRunTab(record)) this.close();
    else { this.note = { text: "L'onglet de ce run est fermé.", error: true }; cx.notify(); }
  }

  resume(record, cx) {
    cx.spawn(async (cx) => {
      const problem = await resumeInTab(record);
      if (problem) { this.note = { text: `Reprise impossible : ${problem}`, error: true }; cx.notify(); }
      else this.close();
    });
  }

  deleteRun(record, withWorktree, cx) {
    this.confirmingRunDelete = null;
    closeRunTab(record);
    updateStore((store) => { store.runs = store.runs.filter((r) => r.id !== record.id); });
    cx.notify();
    cx.spawn(async (cx) => {
      await removeRunFiles(record).catch(() => {});
      if (!withWorktree || !record.worktree) return;
      try {
        const kept = await cleanWorktree(record.worktree);
        this.note = kept
          ? { text: `Worktree gardé (${kept}) : ${record.worktree.path}`, error: true }
          : { text: `Worktree et branche ${record.worktree.branch} supprimés.`, error: false };
      } catch (error) {
        this.note = { text: `Nettoyage impossible : ${error?.message ?? error}`, error: true };
      }
      cx.notify();
    });
  }

  // --- Drawing ---------------------------------------------------------------------------------

  render(cx) {
    const t = theme();
    const { routines, runs } = readStore();
    const running = runs.filter((r) => r.status === "running").length;
    return v_flex().id("routines-screen").size_full().bg(t.canvas).text_color(t.foreground).text_size(13)
      .track_focus(this.handle).on_key_down((e, cx) => this.onKey(e, cx))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(h_flex().id("routines-header").h(42).flex_none().px(14).gap(10).items_center().bg(t.chrome).border_b(1).border_color(t.border)
        .child(svg(CLOCK).size(15).text_color(t.accent))
        .child(div().text_size(14).font_semibold().child("Routines"))
        .child(div().text_size(11.5).text_color(t.dim)
          .child(`${routines.length} routine${routines.length > 1 ? "s" : ""}${running ? ` · ${running} en cours` : ""}`))
        .child(div().flex_1())
        .child(div().text_size(11).text_color(t.dim).child("Esc pour fermer"))
        .child(h_flex().id("routines-close").size(26).flex_none().items_center().justify_center().rounded(6).text_color(t.dim)
          .cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip("Fermer (Esc)")
          .on_click(() => this.close()).child(svg(CLOSE).size(12))))
      .child(h_flex().flex_1().min_h(0).p(8).gap(8).items_start()
        .child(this.routineList(routines, runs, t))
        .child(this.editing ? this.editor(t) : this.history(routines, runs, t)));
  }

  card(id) {
    const t = theme();
    return v_flex().id(id).h_full().min_h(0).rounded(10).border_1().border_color(t.border).bg(t.background).overflow_hidden();
  }

  sectionTitle(text, t, count) {
    return h_flex().gap(6).items_center().text_size(11.5).font_semibold().text_color(t.muted)
      .child(div().child(text))
      .when(count !== undefined, (el) => el.child(div().px(6).rounded(8).text_size(10.5).bg(t.accent + "26").text_color(t.accent).child(String(count))));
  }

  stepButton(id, label, tint, onPress, { disabled = false, tooltip = null } = {}) {
    return div().id(id).h(20).px(8).flex().flex_none().items_center().rounded(5)
      .text_size(11).font_medium().border_1().border_color(tint + "55").bg(tint + "1a").text_color(tint)
      .when(disabled, (el) => el.opacity(0.5))
      .when(!disabled, (el) => el.cursor_pointer().hover((s) => s.bg(tint + "33")))
      .when(Boolean(tooltip), (el) => el.tooltip(tooltip))
      .on_click((_e, cx) => { cx.stop_propagation(); if (!disabled) onPress(cx); })
      .child(label);
  }

  textButton(id, label, kind, onPress) {
    const t = theme();
    const look = {
      primary: [t.solid, t.solid, t.solid_foreground],
      danger: [t.ansi1, t.ansi1, "#ffffff"],
      plain: [t.input, t.raised, t.foreground],
    }[kind];
    return h_flex().id(id).h(28).px(12).flex_none().items_center().rounded(7).border_1()
      .border_color(look[0]).bg(look[1]).text_color(look[2]).text_size(12).font_medium()
      .cursor_pointer().hover((s) => s.opacity(0.88)).on_click((_e, cx) => onPress(cx)).child(label);
  }

  toggle(id, on, onFlip, { disabled = false } = {}) {
    const t = theme();
    return h_flex().id(id).w(34).h(20).p(2).flex_none().rounded(10)
      .bg(on ? t.accent : t.input).when(on, (el) => el.justify_end())
      .when(disabled, (el) => el.opacity(0.4))
      .when(!disabled, (el) => el.cursor_pointer())
      .on_click((_e, cx) => { cx.stop_propagation(); if (!disabled) onFlip(cx); })
      .child(div().size(16).rounded(8).bg("#ffffff"));
  }

  routineList(routines, runs, t) {
    const all = h_flex().id("routine-filter-all").h(30).px(10).gap(8).items_center().rounded(7).cursor_pointer()
      .bg(this.filter === null ? t.selected : t.background).text_color(this.filter === null ? t.foreground : t.muted)
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { this.filter = null; cx.notify(); })
      .child(div().flex_1().text_size(12.5).child("Tous les runs"))
      .child(div().text_size(11).text_color(t.dim).child(String(runs.length)));
    return this.card("routine-list").w(LIST_WIDTH).flex_none()
      .child(h_flex().flex_none().px(12).pt(12).pb(8).items_center()
        .child(div().flex_1().child(this.sectionTitle("Routines", t, routines.length)))
        .child(this.stepButton("routine-new", "+ Nouvelle routine", t.accent, (cx) => this.startEditing(null, cx))))
      .child(div().flex_none().px(8).pb(6).child(all))
      .child(v_flex().id("routine-cards").flex_1().min_h(0).overflow_y_scrollbar().px(8).pb(8).gap(6)
        .when(routines.length === 0, (el) => el.child(div().px(6).py(10).text_size(12).text_color(t.dim)
          .child("Aucune routine. Une routine lance Claude Code selon un planning, dans un onglet du space Routines.")))
        .children(routines.map((routine) => this.routineCard(routine, runs, t))));
  }

  routineCard(routine, runs, t) {
    const selected = this.filter === routine.id || this.editing?.draft.id === routine.id;
    const isRunning = runs.some((r) => r.routine === routine.id && r.status === "running");
    const next = routine.enabled ? nextRunOf(routine.schedule) : null;
    const tags = [routine.print ? "-p" : "interactif", routine.worktree ? "worktree" : null, MODELS.find((m) => m.id === routine.model)?.label].filter(Boolean);
    const launching = this.busy.has(routine.id);
    return v_flex().id(`routine-${routine.id}`).flex_none().p(10).gap(4).rounded(8).border_1()
      .border_color(selected ? t.accent : t.border).bg(selected ? t.selected : t.surface)
      .cursor_pointer().hover((s) => s.border_color(selected ? t.accent : t.input))
      .on_click((_e, cx) => { this.filter = this.filter === routine.id ? null : routine.id; this.editing = null; cx.notify(); })
      .child(h_flex().gap(7).items_center()
        .when(isRunning, (el) => el.child(svg(SPINNER).size(12).flex_none().text_color(t.working).spin(900)))
        .child(div().flex_1().min_w(0).truncate().text_size(13).font_medium()
          .text_color(routine.enabled ? t.foreground : t.muted).child(routine.name))
        .child(this.toggle(`routine-enabled-${routine.id}`, routine.enabled, (cx) => this.setEnabled(routine.id, !routine.enabled, cx))))
      .when(Boolean(routine.description), (el) => el.child(div().text_size(11.5).text_color(t.muted).truncate().child(routine.description)))
      .child(h_flex().gap(6).items_center().text_size(11.5).text_color(t.muted)
        .child(div().min_w(0).truncate().child(describeSchedule(routine.schedule)))
        .child(div().flex_none().text_color(t.dim).child(`· ${tags.join(" · ")}`)))
      .child(div().text_size(11).text_color(t.dim)
        .child(!routine.enabled ? "Désactivée" : next ? `Prochaine exécution : ${formatWhen(next)}` : "Pas de prochaine exécution"))
      .child(h_flex().pt(2).gap(6)
        .child(this.stepButton(`routine-launch-${routine.id}`, launching ? "Lancement…" : "Lancer maintenant", t.accent,
          (cx) => this.launchNow(routine, cx), { disabled: !routine.enabled || launching, tooltip: routine.enabled ? "Lancer un run hors planning" : "Routine désactivée" }))
        .child(this.stepButton(`routine-edit-${routine.id}`, "Modifier", t.muted, (cx) => this.startEditing(routine, cx))));
  }

  history(routines, runs, t) {
    const routine = routines.find((r) => r.id === this.filter);
    const shown = runs.filter((r) => !this.filter || r.routine === this.filter).sort((a, b) => b.startedAt - a.startedAt);
    return this.card("routine-history").flex_1().min_w(0)
      .child(h_flex().flex_none().px(14).pt(12).pb(8).gap(8).items_center()
        .child(this.sectionTitle(routine ? `Historique · ${routine.name}` : "Historique · toutes les routines", t, shown.length)))
      .when(Boolean(this.note), (el) => el.child(h_flex().id("routine-note").flex_none().mx(14).mb(6).gap(8).items_center()
        .text_size(11.5).text_color(this.note.error ? t.ansi1 : t.ansi2)
        .child(div().flex_1().min_w(0).child(this.note.text))
        .child(div().id("routine-note-close").cursor_pointer().text_color(t.dim).on_click((_e, cx) => { this.note = null; cx.notify(); }).child("×"))))
      .child(v_flex().id("run-rows").flex_1().min_h(0).overflow_y_scrollbar().px(8).pb(8).gap(2)
        .when(shown.length === 0, (el) => el.child(div().px(6).py(10).text_size(12).text_color(t.dim)
          .child(routine ? "Aucun run pour cette routine." : "Aucun run.")))
        .children(shown.map((record) => this.runRow(record, !routine, t))));
  }

  statusMark(record, t) {
    if (record.status === "running") return svg(SPINNER).size(12).flex_none().text_color(t.working).spin(900);
    const glyph = { done: "✓", failed: "✗", missed: "⊘" }[record.status] ?? "·";
    return div().w(12).flex_none().text_size(12).font_bold().text_color(statusColor(t, record.status)).child(glyph);
  }

  runRow(record, showRoutineName, t) {
    const expanded = this.expandedRun === record.id;
    const confirming = this.confirmingRunDelete === record.id;
    const ended = record.endedAt ?? (record.status === "running" ? Date.now() : null);
    const duration = record.status === "missed" ? "" : formatDuration((ended ?? record.startedAt) - record.startedAt);
    const detail = record.status === "missed"
      ? `${record.missed > 1 ? `${record.missed} exécutions manquées` : "Exécution manquée"} : Herdr était fermé`
      : record.error || firstLine(record.summary) || (record.status === "running" ? "En cours…" : "");
    const highlighted = this.highlightedRun === record.id;
    return v_flex().id(`run-${record.id}`).flex_none().px(8).py(6).gap(3).rounded(7)
      .when(highlighted || expanded, (el) => el.bg(t.selected))
      .when(record.status !== "missed", (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)))
      .tooltip(record.status === "missed" ? "" : record.print ? "Voir le résultat" : "Aller à l'onglet du run")
      .on_click((_e, cx) => this.openRun(record, cx))
      .child(h_flex().gap(8).items_center()
        .child(this.statusMark(record, t))
        .child(div().flex_none().text_size(12.5).font_medium().child(formatWhen(record.startedAt)))
        .when(showRoutineName, (el) => el.child(div().min_w(0).truncate().text_size(12).text_color(t.muted).child(record.routineName)))
        .child(div().flex_none().text_size(11).text_color(statusColor(t, record.status)).child(STATUS_LABEL[record.status] ?? record.status))
        .when(record.print, (el) => el.child(this.badge("-p", t)))
        .when(record.manual, (el) => el.child(this.badge("manuel", t)))
        .when(Boolean(record.worktree), (el) => el.child(h_flex().flex_none().gap(3).items_center().max_w(220).text_size(11).text_color(t.dim)
          .child(svg(BRANCH).size(11).flex_none()).child(div().min_w(0).truncate().child(record.worktree.branch))))
        .child(div().flex_1())
        .child(div().flex_none().text_size(11).text_color(t.dim).child(duration))
        .child(h_flex().id(`run-delete-${record.id}`).size(22).flex_none().items_center().justify_center().rounded(5).text_color(t.dim)
          .cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.ansi1)).tooltip("Supprimer ce run")
          .on_click((_e, cx) => { cx.stop_propagation(); this.confirmingRunDelete = record.id; cx.notify(); })
          .child(svg(TRASH).size(12))))
      .when(Boolean(detail) && !expanded, (el) => el.child(div().pl(20).text_size(11.5).truncate()
        .text_color(record.error ? t.ansi1 : t.muted).child(detail)))
      .when(expanded, (el) => el.child(this.runDetail(record, t)))
      .when(confirming, (el) => el.child(this.runDeleteConfirmation(record, t)));
  }

  badge(text, t) {
    return div().flex_none().px(5).rounded(4).text_size(10.5).bg(t.raised).text_color(t.muted).child(text);
  }

  runDetail(record, t) {
    const canResume = record.status !== "running" && Boolean(record.sessionId);
    return v_flex().pl(20).pt(4).gap(8)
      .when(Boolean(record.error), (el) => el.child(div().text_size(12).text_color(t.ansi1).child(record.error)))
      .child(v_flex().id(`run-summary-${record.id}`).p(10).rounded(6).bg(t.surface).border_1().border_color(t.border).text_size(12.5)
        .on_click((_e, cx) => cx.stop_propagation())
        .child(record.summary
          ? TextView.markdown(`run-md-${record.id}`, record.summary).selectable(true)
          : div().text_color(t.dim).child(record.status === "running" ? "Claude travaille ; le résumé arrivera à la fin." : "Pas de résumé.")))
      .child(h_flex().gap(6)
        .when(canResume, (el) => el.child(this.stepButton(`run-resume-${record.id}`, "Ouvrir", t.accent, (cx) => this.resume(record, cx),
          { tooltip: `claude --resume ${record.sessionId} dans l'onglet du run` })))
        .child(this.stepButton(`run-tab-${record.id}`, "Voir l'onglet", t.muted, (cx) => this.goToTab(record, cx))));
  }

  runDeleteConfirmation(record, t) {
    return v_flex().id(`run-confirm-${record.id}`).mt(4).p(8).gap(6).rounded(6).bg(t.background).border_1().border_color(t.ansi1 + "55").text_size(12)
      .on_click((_e, cx) => cx.stop_propagation())
      .child(div().child(record.status === "running" ? "Supprimer ce run ? Son onglet sera fermé et Claude arrêté." : "Supprimer ce run ? Son onglet sera fermé."))
      .when(Boolean(record.worktree), (el) => el.child(div().text_size(11).text_color(t.muted)
        .child(`Worktree ${record.worktree.branch} : il ne sera nettoyé que sans modification non commitée ni commit absent de origin.`)))
      .child(h_flex().gap(6)
        .when(Boolean(record.worktree), (el) => el.child(this.textButton(`run-delete-clean-${record.id}`, "Supprimer et nettoyer le worktree", "danger", (cx) => this.deleteRun(record, true, cx))))
        .child(this.textButton(`run-delete-only-${record.id}`, record.worktree ? "Supprimer, garder le worktree" : "Supprimer", record.worktree ? "plain" : "danger", (cx) => this.deleteRun(record, false, cx)))
        .child(this.textButton(`run-delete-cancel-${record.id}`, "Annuler", "plain", (cx) => { this.confirmingRunDelete = null; cx.notify(); })));
  }

  // --- Editor ----------------------------------------------------------------------------------

  field(label, child, hint) {
    const t = theme();
    return v_flex().gap(5)
      .child(div().text_size(11.5).font_semibold().text_color(t.muted).child(label))
      .child(child)
      .when(Boolean(hint), (el) => el.child(div().text_size(11).text_color(t.dim).child(hint)));
  }

  input(state, t, width) {
    const el = Input.new(state).h(30).px(10).rounded(7).border_1().border_color(t.input).bg(t.background).text_size(12.5).text_color(t.foreground);
    return width ? el.w(width).flex_none() : el.flex_1();
  }

  chips(idPrefix, options, chosen, onPick) {
    const t = theme();
    return h_flex().gap(4).flex_wrap().children(options.map((option) => {
      const on = option.id === chosen;
      return h_flex().id(`${idPrefix}-${option.id || "default"}`).h(26).px(10).flex_none().items_center().rounded(6).border_1()
        .border_color(on ? t.accent : t.border).bg(on ? t.selected : t.surface).text_size(12)
        .text_color(on ? t.foreground : t.muted).cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { onPick(option.id); cx.notify(); })
        .child(option.label);
    }));
  }

  optionRow(id, label, hint, on, onFlip, disabled = false) {
    const t = theme();
    return h_flex().gap(10).items_center()
      .child(this.toggle(id, on, (cx) => { onFlip(); cx.notify(); }, { disabled }))
      .child(v_flex().flex_1().min_w(0)
        .child(div().text_size(12.5).text_color(disabled ? t.dim : t.foreground).child(label))
        .child(div().text_size(11).text_color(t.dim).child(hint)));
  }

  scheduleEditor(t) {
    const draft = this.editing.draft;
    const schedule = this.draftSchedule();
    const problem = scheduleError(schedule);
    const next = problem ? null : nextRunOf(schedule);
    const timeRow = h_flex().gap(8).items_center().text_size(12).text_color(t.muted).child("à").child(this.input(this.timeInput, t, 80));
    return v_flex().gap(8)
      .child(this.chips("schedule-kind", PRESETS, schedule.kind, (kind) => { draft.schedule.kind = kind; }))
      .when(schedule.kind === "hourly", (el) => el.child(h_flex().gap(8).items_center().text_size(12).text_color(t.muted)
        .child("à la minute").child(this.input(this.minuteInput, t, 60))))
      .when(schedule.kind === "daily" || schedule.kind === "weekdays", (el) => el.child(timeRow))
      .when(schedule.kind === "weekly", (el) => el.child(h_flex().gap(10).items_center()
        .child(this.chips("schedule-day", WEEKDAYS.map((d) => ({ id: d.day, label: d.short })), Number(schedule.weekday), (day) => { draft.schedule.weekday = day; }))
        .child(timeRow)))
      .when(schedule.kind === "cron", (el) => el.child(v_flex().gap(4)
        .child(h_flex().child(this.input(this.cronInput, t)))
        .child(div().text_size(11).text_color(t.dim).child("5 champs : minute heure jour mois jour-de-semaine. « * * * * * » : chaque minute."))))
      .child(div().text_size(11.5).text_color(problem ? t.ansi1 : t.accent)
        .child(problem ? `Planification invalide : ${problem}` : next ? `Prochaine exécution : ${formatWhen(next)}` : "Aucune exécution dans les 5 ans"));
  }

  editor(t) {
    const { draft, isNew } = this.editing;
    return this.card("routine-editor").flex_1().min_w(0)
      .child(h_flex().flex_none().px(20).pt(16).pb(10).items_center()
        .child(div().flex_1().text_size(15).font_semibold().truncate().child(isNew ? "Nouvelle routine" : `Modifier « ${draft.name} »`))
        .child(h_flex().id("editor-close").size(26).flex_none().items_center().justify_center().rounded(6).text_color(t.dim)
          .cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip("Annuler")
          .on_click((_e, cx) => { this.editing = null; this.handle.focus(); cx.notify(); })
          .child(svg(CLOSE).size(12))))
      .child(v_flex().id("editor-body").flex_1().min_h(0).overflow_y_scrollbar().px(20).pb(16).gap(16)
        .child(h_flex().gap(12)
          .child(div().flex_1().child(this.field("Nom", h_flex().child(this.input(this.nameInput, t)))))
          .child(div().flex_1().child(this.field("Description", h_flex().child(this.input(this.descriptionInput, t))))))
        .child(this.field("Prompt", Textarea.new(this.promptInput).w_full().px(10).py(8).rounded(7).border_1().border_color(t.input)
          .bg(t.background).text_size(12.5).text_color(t.foreground)))
        .child(this.field("Planification", this.scheduleEditor(t)))
        .child(this.field("Répertoire", h_flex().gap(6).child(this.input(this.folderInput, t))
          .child(this.textButton("editor-pick-folder", "Choisir…", "plain", (cx) => this.chooseFolder(cx))),
          draft.worktree ? "Chaque run part d'un nouveau worktree de ce dépôt, sur une branche routine-…" : "La session tourne dans ce répertoire tel quel."))
        .child(h_flex().gap(24).items_start()
          .child(this.field("Modèle", this.chips("editor-model", MODELS, draft.model, (id) => { draft.model = id; })))
          .child(this.field("Effort", this.chips("editor-effort", EFFORTS, draft.effort, (id) => { draft.effort = id; }))))
        .child(this.field("Options", v_flex().gap(10)
          .child(this.optionRow("editor-enabled", "Activée", "Une routine désactivée ne se lance ni sur planning ni à la main.", draft.enabled, () => { draft.enabled = !draft.enabled; }))
          .child(this.optionRow("editor-worktree", "Worktree", "Un nouveau worktree par run, basé sur origin/HEAD.", draft.worktree, () => { draft.worktree = !draft.worktree; }))
          .child(this.optionRow("editor-print", "Mode -p", "claude -p : non interactif, cet écran lit sa sortie ; « Ouvrir » reprend la conversation.", draft.print, () => { draft.print = !draft.print; }))
          .child(this.optionRow("editor-toast", "Toast à la fin", "Une notification Herdr quand le run se termine ou échoue.", draft.toast, () => { draft.toast = !draft.toast; }))
          .child(this.optionRow("editor-push", "Push Claude",
            draft.print ? "Nécessite le mode interactif (Remote Control)." : "Lance Claude avec Remote Control et lui demande un push de résumé sur le téléphone à la fin.",
            draft.push && !draft.print, () => { draft.push = !draft.push; }, draft.print))))
        .child(this.field("Runs gardés", h_flex().child(this.input(this.keepInput, t, 70)), "Au-delà, le plus ancien est purgé : onglet fermé, entrée retirée, worktree nettoyé s'il est propre."))
        .when(Boolean(this.formError), (el) => el.child(div().text_size(12).text_color(t.ansi1).child(this.formError)))
        .child(this.confirmingRoutineDelete
          ? v_flex().p(8).gap(6).rounded(6).border_1().border_color(t.ansi1 + "55").text_size(12)
            .child(div().child(`Supprimer la routine « ${draft.name} » ? Ses runs restent dans l'historique.`))
            .child(h_flex().gap(6)
              .child(this.textButton("editor-delete-confirm", "Supprimer", "danger", (cx) => this.deleteRoutine(draft.id, cx)))
              .child(this.textButton("editor-delete-cancel", "Annuler", "plain", (cx) => { this.confirmingRoutineDelete = false; cx.notify(); })))
          : h_flex().gap(8).items_center()
            .child(this.textButton("editor-save", "Enregistrer", "primary", (cx) => this.saveDraft(cx)))
            .child(this.textButton("editor-cancel", "Annuler", "plain", (cx) => { this.editing = null; this.handle.focus(); cx.notify(); }))
            .child(div().flex_1())
            .when(!isNew, (el) => el.child(this.textButton("editor-delete", "Supprimer la routine", "plain", (cx) => { this.confirmingRoutineDelete = true; cx.notify(); })))));
  }
}
