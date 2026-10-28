import "./personal-session-group-dialog.css";
import { createMemo, createSignal, For, Show } from "solid-js";
import { t } from "../lib/reactive/i18n.ts";
import type { PersonalSessionGroup } from "../lib/sessions/personal-groups.ts";
import type { PersonalSessionGroupCandidate } from "./personal-session-group-actions.ts";
import { Icon } from "./solid/icon.tsx";

export type PersonalSessionGroupDialogOptions = {
  group?: PersonalSessionGroup;
  candidates: readonly PersonalSessionGroupCandidate[];
  selectedKey?: string;
  signal: AbortSignal;
  submit: (value: Pick<PersonalSessionGroup, "label" | "sessionKeys">) => string | null;
};

export function PersonalSessionGroupDialogView(props: {
  options: PersonalSessionGroupDialogOptions;
  finish(): void;
}) {
  const [label, setLabel] = createSignal(() => props.options.group?.label ?? "");
  const [query, setQuery] = createSignal("");
  const [searching, setSearching] = createSignal(false);
  const [selected, setSelected] = createSignal<ReadonlySet<string>>(
    () =>
      new Set(
        props.options.group?.sessionKeys ??
          (props.options.selectedKey ? [props.options.selectedKey] : []),
      ),
  );
  const [error, setError] = createSignal<string | null>(null);
  const rows = createMemo(() => {
    const needle = query().trim().toLocaleLowerCase();
    return needle
      ? props.options.candidates.filter((row) => row.label.toLocaleLowerCase().includes(needle))
      : props.options.candidates;
  });
  const selectedCount = createMemo(
    () => props.options.candidates.filter((row) => selected().has(row.key)).length,
  );
  const title = () =>
    t(props.options.group ? "sessionsView.personalGroupEdit" : "sessionsView.personalGroupNew");
  let nameInput!: HTMLInputElement;
  let searchToggle: HTMLButtonElement | undefined;
  const closeSearch = () => {
    setQuery("");
    setSearching(false);
    queueMicrotask(() => searchToggle?.focus());
  };
  return (
    <openclaw-modal-dialog
      style={{ "--openclaw-modal-width": "480px" }}
      label={title()}
      description={t("sessionsView.personalGroupHint")}
      prop:initialFocus={() => nameInput}
      onModal-cancel={() => props.finish()}
    >
      <form
        class="exec-approval-card exec-approval-modal-stack personal-session-group-dialog personal-section-dialog"
        onSubmit={(event) => {
          event.preventDefault();
          if (!label().trim()) {
            return;
          }
          const result = props.options.submit({
            label: label().trim(),
            sessionKeys: [...selected()],
          });
          if (result) {
            setError(result);
          } else {
            props.finish();
          }
        }}
      >
        <header class="personal-section-dialog__header">
          <div class="personal-section-dialog__title-row">
            <div class="exec-approval-title">{title()}</div>
            <span class="chip personal-section-dialog__chip">
              {t("sessionsView.personalGroupChip")}
            </span>
          </div>
          {/* Sections reference sessions; they are not shared groups and never move a session. */}
          <p class="muted personal-section-dialog__description">
            {t("sessionsView.personalGroupHint")}
          </p>
        </header>
        <div class="personal-section-dialog__body">
          <label class="field">
            <span>{t("sessionsView.personalGroupName")}</span>
            <input
              ref={(element) => (nameInput = element)}
              type="text"
              maxlength={80}
              value={label()}
              onInput={(event) => setLabel(event.currentTarget.value)}
              required
            />
          </label>
          <div class="personal-section-dialog__list-head">
            <Show
              when={searching()}
              fallback={
                <>
                  <span class="muted">{t("sessionsView.personalGroupSessions")}</span>
                  <span class="muted personal-section-dialog__count">
                    {t("sessionsView.personalGroupSelected", { count: String(selectedCount()) })}
                  </span>
                  <button
                    ref={(element) => (searchToggle = element)}
                    type="button"
                    class="btn btn--sm btn--icon btn--ghost"
                    aria-label={t("sessionsView.personalGroupSearch")}
                    title={t("sessionsView.personalGroupSearch")}
                    aria-expanded="false"
                    onClick={() => setSearching(true)}
                  >
                    <Icon name="search" />
                  </button>
                </>
              }
            >
              <input
                ref={(element) => {
                  // Escape belongs to the search field: clear it, then close it, before the
                  // native dialog can treat the key as a cancel request.
                  element.addEventListener("keydown", (event) => {
                    if (event.key !== "Escape" || event.isComposing) {
                      return;
                    }
                    event.preventDefault();
                    event.stopPropagation();
                    if (element.value) {
                      element.value = "";
                      setQuery("");
                    } else {
                      closeSearch();
                    }
                  });
                  queueMicrotask(() => element.focus());
                }}
                type="search"
                class="input personal-section-dialog__search"
                aria-label={t("sessionsView.personalGroupSearch")}
                placeholder={t("sessionsView.personalGroupSearch")}
                value={query()}
                onInput={(event) => setQuery(event.currentTarget.value)}
              />
              <button
                type="button"
                class="btn btn--sm btn--icon btn--ghost"
                aria-label={t("sessionsView.personalGroupSearchClose")}
                title={t("sessionsView.personalGroupSearchClose")}
                onClick={closeSearch}
              >
                <Icon name="x" />
              </button>
            </Show>
          </div>
          <div
            role="group"
            aria-label={t("sessionsView.personalGroupSessions")}
            class="personal-session-group-dialog__sessions personal-section-dialog__sessions"
          >
            <For each={rows()} keyed={(row) => row.key}>
              {(row) => (
                <label class="field checkbox personal-session-group-dialog__session">
                  <input
                    type="checkbox"
                    checked={selected().has(row().key)}
                    onChange={(event) => {
                      const checked = event.currentTarget.checked;
                      setSelected((previous) => {
                        const next = new Set(previous);
                        if (checked) {
                          next.add(row().key);
                        } else {
                          next.delete(row().key);
                        }
                        return next;
                      });
                    }}
                  />
                  <span>{row().label}</span>
                </label>
              )}
            </For>
            <Show when={rows().length === 0}>
              <p class="muted">{t("sessionsView.personalGroupNoMatches")}</p>
            </Show>
          </div>
          <Show when={error()}>
            <div role="alert" class="exec-approval-error">
              {error()}
            </div>
          </Show>
          <openclaw-modal-actions class="exec-approval-actions">
            <button type="button" class="btn" onClick={() => props.finish()}>
              {t("common.cancel")}
            </button>
            <button type="submit" class="btn primary" disabled={!label().trim()}>
              {t("common.save")}
            </button>
          </openclaw-modal-actions>
        </div>
      </form>
    </openclaw-modal-dialog>
  );
}
