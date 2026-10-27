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

/** Decorative preview: a session row repeated in your own section. */
function SectionIllustration() {
  const bar = "fill:color-mix(in srgb, var(--text) 15%, transparent)";
  return (
    <svg viewBox="0 0 66 54" width="66" height="54" aria-hidden="true" style="flex:none">
      <g transform="rotate(-7 23 19)" opacity="0.7">
        <rect
          x="1.5"
          y="2.5"
          width="44"
          height="34"
          rx="9"
          style="fill:var(--card);stroke:var(--border)"
        />
        <rect x="9" y="11" width="29" height="4" rx="2" style={bar} />
        <rect x="9" y="19" width="21" height="4" rx="2" style={bar} />
        <rect x="9" y="27" width="25" height="4" rx="2" style={bar} />
      </g>
      <rect
        x="20.5"
        y="16.5"
        width="44"
        height="36"
        rx="9"
        style="fill:var(--card);stroke:color-mix(in srgb, var(--accent) 45%, var(--border))"
      />
      <g
        transform="translate(28 23) scale(0.42)"
        style="fill:none;stroke:var(--accent)"
        stroke-width="2.4"
      >
        <path d="m12 3 10 5-10 5L2 8Z" />
        <path d="m2 12 10 5 10-5M2 16l10 5 10-5" />
      </g>
      <rect
        x="40"
        y="27"
        width="18"
        height="4"
        rx="2"
        style="fill:color-mix(in srgb, var(--accent) 35%, transparent)"
      />
      <rect
        x="28"
        y="36"
        width="27"
        height="4"
        rx="2"
        style="fill:color-mix(in srgb, var(--accent) 60%, transparent)"
      />
      <rect x="28" y="44" width="31" height="4" rx="2" style={bar} />
    </svg>
  );
}

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
        <header class="personal-section-dialog__hero">
          <SectionIllustration />
          <div class="personal-section-dialog__intro">
            <div class="exec-approval-title">{title()}</div>
            <span
              class="chip personal-section-dialog__chip"
              title={t("sessionsView.personalGroupHint")}
            >
              <Icon name="eye" />
              {t("sessionsView.personalGroupChip")}
            </span>
          </div>
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
