/**
 * Central selector registry for the NotebookLM web UI.
 *
 * # Multilingual strategy
 *
 * Google ships NotebookLM in dozens of locales. Anchor priority:
 *
 *   1. **Class names** (`.add-source-button`, `.single-source-container`,
 *      `.submit-button`, `.create-artifact-button-container`, …) — these
 *      are Angular component selectors and identical in every locale.
 *
 *   2. **Material-Symbols icon names** (`audio_magic_eraser`, `content_paste`,
 *      `link`, `upload`, `download`, …) — Google ships them as the literal
 *      text node of `<mat-icon>` in every locale, so they are 100% language-
 *      agnostic. Most stable anchor for icon-driven controls.
 *
 *   3. **`role="dialog"`, `role="button"`** — set synchronously by Angular,
 *      no animation race.
 *
 *   4. **Locale-bound aria-labels and visible text** — last resort. Each
 *      list below covers the eight major NotebookLM locales:
 *      EN, DE, FR, ES, PT, IT, NL, JA. Adding more is mechanical; nothing
 *      breaks if a locale is missing because the class/icon anchors fire
 *      first.
 *
 * Last verified: 2026-05 against the live notebooklm.google.com layout
 * (DE, EN locales).
 */

/**
 * Material-Symbols icon anchor shared by every selector that needs to scope
 * a match to Audio Overview's own tile/card (as opposed to any artifact
 * tile). Declared as a module-level const — not a sibling property inside
 * the `Selectors` object literal below — because a property initializer
 * inside an object literal cannot reference another property of that same
 * object while it is still being constructed; a module-level const is the
 * only way to give this string a single source of truth that the
 * `readySelectors`/`audioMoreMenuButton` entries can compose into their
 * template strings instead of re-typing it inline. See
 * `Selectors.studio.audioTileIconAnchor` below for the "unverified, revise
 * after live recon" caveat this string carries.
 */
const AUDIO_TILE_ICON_ANCHOR = 'mat-icon:text-is("audio_magic_eraser")';

/**
 * Material-Symbols icon ligature per Studio output type. Confirmed LIVE
 * 2026-08-23 against the real notebook.google.com layout: every trigger
 * tile in `.create-artifact-button-container` carries one of these as its
 * `<mat-icon>` text, AND — confirmed against real, already-completed
 * artifacts (not guessed) — a finished tile in `.artifact-item-button`
 * re-displays the SAME ligature. This is the primary, verified scoping
 * anchor for every per-type selector below; it is locale-independent, so
 * it also replaces the need for a per-locale aria-label fallback chain on
 * these newer types the way `audioOverviewButton` still carries one.
 *
 * "audio" kept here even though `AUDIO_TILE_ICON_ANCHOR` above already
 * exists — that const predates this map and stays for the string literals
 * that reference it directly; this map exists so the studio-file-kind
 * strategy files (Task 2+) can look up any type's ligature by name.
 */
export const STUDIO_TILE_ICON_LIGATURES: Record<string, string> = {
  audio: "audio_magic_eraser",
  slides: "tablet",
  video: "subscriptions",
  mindmap: "flowchart",
  report: "auto_tab_group",
  flashcards: "cards_star",
  quiz: "quiz",
  infographic: "stacked_bar_chart",
  datatable: "table_view",
};

/**
 * Trigger-tile selector for any Studio output type, scoped by its icon
 * ligature — the entry-point control that starts generation. Confirmed
 * live 2026-08-23: `div[role="button"].create-artifact-button-container`
 * with a `<mat-icon>` whose text is the type's ligature and an
 * `aria-label` equal to the (English) display name. The `aria-label`
 * candidate is kept as a fallback for locales where the ligature text
 * might legitimately differ (unverified — no non-English locale was
 * checked this session), matching this file's own anchor-priority
 * convention (class/icon over locale-bound text).
 */
export function studioTriggerSelectors(ligature: string, englishAriaLabel: string): string[] {
  return [
    `.create-artifact-button-container:has(mat-icon:text-is("${ligature}"))`,
    `[role="button"]:has(mat-icon:text-is("${ligature}"))`,
    `[role="button"][aria-label="${englishAriaLabel}"]`,
  ];
}

/**
 * Completed-tile selector for any Studio output type, scoped by its icon
 * ligature. `.artifact-item-button` is the CONFIRMED LIVE (2026-08-23)
 * completed-artifact container — NOT the `artifact-library-item` custom
 * element `audioPlayer`/`audioMoreMenuButton` previously assumed (that
 * assumption was written as an explicit, never-live-verified hypothesis
 * during Task 6, 2026-08-22, without an authenticated account available;
 * it does not match any element in the current DOM — the NotebookLM UI
 * markup has changed since the pre-Task-6 selectors were last verified,
 * 2026-05).
 */
export function studioReadyTileSelectors(ligature: string): string[] {
  return [`.artifact-item-button:has(mat-icon:text-is("${ligature}"))`];
}

/**
 * The three-dot "more" menu button for a completed tile, scoped to that
 * SPECIFIC type via its ligature (not "the first more-button on the
 * page"). Confirmed live 2026-08-23: clicking it opens a
 * `.mat-mdc-menu-panel` with type-specific items (e.g. Slide Deck offers
 * "Download PDF Document (.pdf)" and "Download PowerPoint (.pptx)";
 * Video Overview and Infographic each offer a single "Download"; Reports
 * offers "Export to Docs"/"Export to Sheets" instead of a direct
 * download — see each type's own strategy file for its specific menu-item
 * handling).
 */
export function studioMoreMenuSelectors(ligature: string): string[] {
  return [
    `.artifact-item-button:has(mat-icon:text-is("${ligature}")) button:has(mat-icon:text-is("more_vert"))`,
  ];
}

export const Selectors = {
  chat: {
    answerContainer: ".to-user-container",
    answerText: ".to-user-container .message-text-content",
    latestAnswerText: ".to-user-container:last-child .message-text-content",
    /**
     * Chat textarea. The class is shared across locales; aria-labels are a
     * fallback for older builds where the class was different.
     */
    queryInput: [
      "textarea.query-box-input",
      'textarea[aria-label*="query" i]',
      'textarea[aria-label*="anfrag" i]',
      'textarea[aria-label*="requete" i]',
      'textarea[aria-label*="zone de requete" i]',
      'textarea[aria-label*="consulta" i]',
      'textarea[aria-label*="domanda" i]',
      'textarea[aria-label*="vraag" i]',
      'textarea[aria-label*="質問" i]',
      'textarea[aria-label*="pergunta" i]',
    ],
    /**
     * The chat submit button has the *language-bound* aria-label
     * (Send / Senden / Envoyer / Enviar / Invia / Verzenden / 送信). It also
     * has the stable class `.submit-button`. The sources web-search overlay
     * uses `.actions-enter-button` with the SAME aria-label, so we MUST
     * anchor on `.submit-button` to avoid distractor matches.
     */
    submitButton: [
      "button.submit-button",
      'button.submit-button[aria-label*="send" i]',
      'button.submit-button[aria-label*="senden" i]',
      'button.submit-button[aria-label*="envoyer" i]',
      'button.submit-button[aria-label*="enviar" i]',
      'button.submit-button[aria-label*="invia" i]',
      'button.submit-button[aria-label*="verzend" i]',
      'button.submit-button[aria-label*="送信" i]',
    ],
  },

  /**
   * NotebookLM removed tabs in favour of a three-pane sidebar (2026 layout).
   * These selectors are kept only for the rare legacy layouts.
   */
  tabs: {
    discussion: [
      '[role="tab"]:has-text("Discussion")',
      '[role="tab"]:has-text("Diskussion")',
      '[role="tab"]:has-text("Diskussionen")',
      '[role="tab"]:has-text("Discusión")',
      '[role="tab"]:has-text("Discussione")',
      '[role="tab"]:has-text("Discussão")',
      '[role="tab"]:has-text("ディスカッション")',
    ],
    sources: [
      '[role="tab"]:has-text("Sources")',
      '[role="tab"]:has-text("Quellen")',
      '[role="tab"]:has-text("Fuentes")',
      '[role="tab"]:has-text("Fonti")',
      '[role="tab"]:has-text("Fontes")',
      '[role="tab"]:has-text("Bronnen")',
      '[role="tab"]:has-text("ソース")',
    ],
    activeTabClass: "mdc-tab--active",
    tabList: ".mat-mdc-tab-list .mdc-tab",
  },

  citations: {
    button: [
      "button.citation-marker",
      "button.xap-inline-dialog.citation-marker",
      "button[data-citation]",
    ],
    label: "span[aria-label]",
    highlight: ".highlighted",
    paragraph: ".paragraph",
    paragraphHighlight: ".paragraph .highlighted",
  },

  sources: {
    /**
     * Per-source row in the sidebar (language-agnostic). Stable Angular
     * class — verified across all observed locales.
     */
    sourceContainer: ".single-source-container",
    /**
     * "X Quellen" / "X sources" header text. Numeric so we read the count
     * via regex on the visible text. Independent of sidebar collapse state.
     */
    sourceCountIndicator: ".cover-subtitle-source-count",
    /**
     * Sidebar "Add source" button. Class `.add-source-button` is language-
     * agnostic; aria-labels listed for older builds without the class.
     */
    addButton: [
      "button.add-source-button",
      'button[aria-label="Add source"]',
      'button[aria-label*="add source" i]',
      'button[aria-label*="quelle hinzu" i]',
      'button[aria-label*="ajouter une source" i]',
      'button[aria-label*="añadir fuente" i]',
      'button[aria-label*="agregar fuente" i]',
      'button[aria-label*="aggiungi fonte" i]',
      'button[aria-label*="adicionar fonte" i]',
      'button[aria-label*="bron toevoegen" i]',
      'button[aria-label*="ソースを追加" i]',
    ],
    /**
     * Real Material modal. `[role="dialog"]` is set by Angular synchronously
     * the moment the modal mounts — race-free against the `.mdc-dialog--open`
     * animation class and resistant to Material-UI version bumps. Avoid
     * `.cdk-overlay-pane` (matches every dropdown / emoji picker / menu).
     */
    overlayPane: '[role="dialog"]',
    overlayInput: '[role="dialog"] input[type="text"]:not([readonly])',
    overlayTextarea: '[role="dialog"] textarea',
    /**
     * Source-type buttons in the Add-source overlay. Google ships them
     * *without* aria-labels — the only stable, language-agnostic anchor is
     * the Material-Symbols icon name baked into a `<mat-icon>` text node.
     */
    sourceTypeUrl: [
      // Icon-anchored (language-free) — primary path.
      "button.drop-zone-icon-button:has(mat-icon.youtube-icon)",
      'button.drop-zone-icon-button:has(mat-icon:text-is("link"))',
      // Visible-text fallbacks for the eight major locales.
      'button.drop-zone-icon-button:has-text("Websites")',
      'button.drop-zone-icon-button:has-text("Website")',
      'button.drop-zone-icon-button:has-text("Sites Web")',
      'button.drop-zone-icon-button:has-text("Sitio web")',
      'button.drop-zone-icon-button:has-text("Sito web")',
      'button.drop-zone-icon-button:has-text("Sites")',
      'button.drop-zone-icon-button:has-text("ウェブサイト")',
      'span:has-text("Website")',
      'span:has-text("URL")',
    ],
    sourceTypeText: [
      // Icon-anchored (language-free) — primary path.
      'button.drop-zone-icon-button:has(mat-icon:text-is("content_paste"))',
      // Visible-text fallbacks for major locales.
      'button.drop-zone-icon-button:has-text("Kopierter Text")',
      'button.drop-zone-icon-button:has-text("Copied text")',
      'button.drop-zone-icon-button:has-text("Pasted text")',
      'button.drop-zone-icon-button:has-text("Texte copié")',
      'button.drop-zone-icon-button:has-text("Texto copiado")',
      'button.drop-zone-icon-button:has-text("Testo copiato")',
      'button.drop-zone-icon-button:has-text("Gekopieerde tekst")',
      'button.drop-zone-icon-button:has-text("コピーしたテキスト")',
      'span:has-text("Copied text")',
      'span:has-text("Pasted text")',
      '[data-type="text"]',
    ],
    sourceTypeYoutube: [
      "button.drop-zone-icon-button mat-icon.youtube-icon",
      'button.drop-zone-icon-button:has(mat-icon:text-is("video_youtube"))',
    ],
    sourceTypeFile: [
      'input[type="file"]',
      'button.drop-zone-icon-button:has(mat-icon:text-is("upload"))',
      'button.drop-zone-icon-button:has-text("Dateien hochladen")',
      'button.drop-zone-icon-button:has-text("Upload sources")',
      'button.drop-zone-icon-button:has-text("Importer")',
      'button.drop-zone-icon-button:has-text("Subir")',
      'button.drop-zone-icon-button:has-text("Carica")',
      'button.drop-zone-icon-button:has-text("Uploaden")',
      'button.drop-zone-icon-button:has-text("アップロード")',
    ],
    /**
     * Primary submit button in the add-source dialog. Material's
     * `.mdc-button--raised` class is the most stable anchor; per-locale
     * visible-text variants are fallbacks for older builds.
     */
    insertConfirm: [
      // Class-anchored (language-free).
      'button.mdc-button--raised:has-text("Insert")',
      'button.mat-flat-button:has-text("Insert")',
      'button[color="primary"]:has-text("Insert")',
      // Visible-text fallbacks for major locales.
      'button.mdc-button--raised:has-text("Einfügen")',
      'button.mdc-button--raised:has-text("Hinzufügen")',
      'button.mdc-button--raised:has-text("Ajouter")',
      'button.mdc-button--raised:has-text("Insertar")',
      'button.mdc-button--raised:has-text("Inserisci")',
      'button.mdc-button--raised:has-text("Invoegen")',
      'button.mdc-button--raised:has-text("挿入")',
      'button:has-text("Insert")',
      'button:has-text("Einfügen")',
      'button:has-text("Hinzufügen")',
      'button:has-text("Ajouter")',
      'button:has-text("Insérer")',
      'button:has-text("Insertar")',
      'button:has-text("Añadir")',
      'button:has-text("Agregar")',
      'button:has-text("Inserisci")',
      'button:has-text("Aggiungi")',
      'button:has-text("Inserir")',
      'button:has-text("Adicionar")',
      'button:has-text("Invoegen")',
      'button:has-text("Toevoegen")',
      'button:has-text("挿入")',
      'button:has-text("追加")',
      'button:has-text("Add")',
      'button:has-text("Submit")',
      'button[type="submit"]',
      '[role="dialog"] .mdc-dialog__actions button:not(:has-text("Cancel")):not(:has-text("Close")):not(:has-text("Schließen")):not(:has-text("Annuler")):not(:has-text("Cancelar")):not(:has-text("Annulla")):not(:has-text("Annuleren")):not(:has-text("キャンセル"))',
    ],
  },

  studio: {
    /**
     * Tile-scoping icon anchor for Audio Overview specifically. Backed by
     * the module-level `AUDIO_TILE_ICON_ANCHOR` const above.
     *
     * RESOLVED 2026-08-23 (was "hypothesis, not live-verified" from Task 6,
     * 2026-08-22): confirmed live, against real completed artifacts, that a
     * finished tile DOES re-display its trigger's icon ligature — but in
     * `.artifact-item-button`, not the `artifact-library-item` custom
     * element this anchor and `audioPlayer`/`audioMoreMenuButton` below
     * previously assumed. That element does not exist anywhere in the
     * current DOM; see `studioReadyTileSelectors`/`studioMoreMenuSelectors`
     * above, now used directly by `audioPlayer`/`audioMoreMenuButton`
     * below — this makes those genuinely tile-scoped (a real CSS AND via
     * `:has()`, not a same-priority OR-with-a-broad-catch-all), which is
     * what makes it safe to register a second Studio output type.
     */
    audioTileIconAnchor: AUDIO_TILE_ICON_ANCHOR,
    /**
     * "Audio Overview" entry control. As of the 2026-05 Studio layout this
     * is a `<div role="button">` with a Material-Symbols `audio_magic_eraser`
     * icon, NOT a real `<button>`. Icon-anchored selectors fire first.
     */
    audioOverviewButton: [
      // Icon-anchored (language-free) — primary path.
      '.create-artifact-button-container:has(mat-icon:text-is("audio_magic_eraser"))',
      '[role="button"]:has(mat-icon:text-is("audio_magic_eraser"))',
      // Locale-bound aria-labels for the eight major locales.
      '[role="button"][aria-label*="audio-zusammenfassung" i]',
      '[role="button"][aria-label*="audio overview" i]',
      '[role="button"][aria-label*="aperçu audio" i]',
      '[role="button"][aria-label*="resumen de audio" i]',
      '[role="button"][aria-label*="panoramica audio" i]',
      '[role="button"][aria-label*="visão geral de áudio" i]',
      '[role="button"][aria-label*="audio-overzicht" i]',
      '[role="button"][aria-label*="音声の概要" i]',
      '[role="button"][aria-label*="audio" i]',
      // Legacy <button> fallbacks for older builds.
      'button:has(mat-icon:text-is("audio_magic_eraser"))',
      'button[aria-label*="audio overview" i]',
      'button[aria-label*="audio-zusammenfassung" i]',
      'button[aria-label*="podcast" i]',
    ],
    /**
     * Generate / Generieren / Générer trigger inside the customise dialog.
     * Visible-text varies by locale.
     */
    generateButton: [
      'button:has-text("Generate")',
      'button:has-text("Generieren")',
      'button:has-text("Générer")',
      'button:has-text("Generer")',
      'button:has-text("Generar")',
      'button:has-text("Genera")',
      'button:has-text("Gerar")',
      'button:has-text("Genereren")',
      'button:has-text("生成")',
    ],
    /**
     * Download trigger. The Studio panel uses an icon-only button with a
     * `download` Material-Symbols glyph; aria-label is locale-bound.
     */
    downloadButton: [
      // Icon-anchored (language-free) — primary path.
      'button:has(mat-icon:text-is("download"))',
      // Locale-bound aria-labels.
      'button[aria-label*="download" i]',
      'button[aria-label*="herunterladen" i]',
      'button[aria-label*="télécharger" i]',
      'button[aria-label*="descargar" i]',
      'button[aria-label*="scarica" i]',
      'button[aria-label*="baixar" i]',
      'button[aria-label*="downloaden" i]',
      'button[aria-label*="ダウンロード" i]',
    ],
    /**
     * Completed Audio-Overview tile. CORRECTED 2026-08-23 (was pre-Task-6,
     * last verified 2026-05): the real container is `.artifact-item-button`
     * (confirmed live against actual completed artifacts), not the
     * `artifact-library-item` custom element these selectors previously
     * assumed — that element matches nothing in the current DOM. Now
     * genuinely tile-scoped via `studioReadyTileSelectors` (a real `:has()`
     * AND on the ligature, not a broad OR that any type's tile would
     * satisfy), which is the fix that makes registering additional Studio
     * output types safe.
     */
    audioPlayer: studioReadyTileSelectors(STUDIO_TILE_ICON_LIGATURES.audio),
    /**
     * Per-tile "Mehr"/"More"/"Plus"/… three-dot button. Opens the menu that
     * contains the Download item. CORRECTED 2026-08-23 — same
     * `artifact-library-item` → `.artifact-item-button` fix as `audioPlayer`
     * above, confirmed live by actually opening this menu on a real
     * completed artifact.
     */
    audioMoreMenuButton: studioMoreMenuSelectors(STUDIO_TILE_ICON_LIGATURES.audio),
    /**
     * Video Overview trigger tile. The tile selector itself was confirmed
     * live 2026-08-23 (real completed artifact in a test
     * notebook). CORRECTION: an earlier version of this comment claimed a
     * one-click entry with no dialog — that was wrong (see audio.ts's
     * header for the full story); the click opens a "Customize Video
     * Overview" dialog requiring an explicit "Generate" click, handled by
     * `triggerViaDialog` (studio-outputs.ts), also confirmed live.
     */
    videoOverviewButton: studioTriggerSelectors(STUDIO_TILE_ICON_LIGATURES.video, "Video Overview"),
    /** Completed Video Overview tile. Confirmed live 2026-08-23. */
    videoOverviewTile: studioReadyTileSelectors(STUDIO_TILE_ICON_LIGATURES.video),
    /**
     * Video Overview's three-dot menu. Confirmed live 2026-08-23: opens a
     * menu with a single `save_alt`-icon "Download" item (no format
     * choice), plus Share/Rename/View prompt and sources/Delete.
     */
    videoOverviewMoreMenuButton: studioMoreMenuSelectors(STUDIO_TILE_ICON_LIGATURES.video),
    /**
     * Infographic trigger tile. The tile selector itself was confirmed
     * live 2026-08-23 (real completed artifacts in a test
     * notebook). CORRECTION: an earlier version of this comment claimed a
     * one-click entry with no dialog — wrong; the click opens a "Customize
     * Infographic" dialog requiring an explicit "Generate" click, handled
     * by `triggerViaDialog` (studio-outputs.ts), also confirmed live.
     */
    infographicButton: studioTriggerSelectors(
      STUDIO_TILE_ICON_LIGATURES.infographic,
      "Infographic"
    ),
    /** Completed Infographic tile. Confirmed live 2026-08-23. */
    infographicTile: studioReadyTileSelectors(STUDIO_TILE_ICON_LIGATURES.infographic),
    /**
     * Infographic's three-dot menu. Confirmed live 2026-08-23: identical
     * shape to Video Overview's — single `save_alt`-icon "Download" item.
     */
    infographicMoreMenuButton: studioMoreMenuSelectors(STUDIO_TILE_ICON_LIGATURES.infographic),
    /**
     * Slide Deck trigger tile. The tile selector itself was confirmed live
     * 2026-08-23 (real completed artifact in a test
     * notebook). CORRECTION: an earlier version of this
     * comment claimed a one-click entry with no dialog — wrong; the click
     * opens a "Customize Slide Deck" dialog requiring an explicit
     * "Generate" click, handled by `triggerViaDialog` (studio-outputs.ts),
     * also confirmed live.
     */
    slidesButton: studioTriggerSelectors(STUDIO_TILE_ICON_LIGATURES.slides, "Slide Deck"),
    /** Completed Slide Deck tile. Confirmed live 2026-08-23. */
    slidesTile: studioReadyTileSelectors(STUDIO_TILE_ICON_LIGATURES.slides),
    /**
     * Slide Deck's three-dot menu. Confirmed live 2026-08-23 — UNLIKE
     * Video/Infographic, this menu offers TWO download formats
     * ("Download PDF Document (.pdf)" and "Download PowerPoint (.pptx)")
     * plus Share/Rename/"Start slideshow"/Revise/"View prompt and
     * sources"/Delete. `slides.ts` defaults to the PDF item.
     */
    slidesMoreMenuButton: studioMoreMenuSelectors(STUDIO_TILE_ICON_LIGATURES.slides),
    /**
     * Slide Deck's PDF download menu item (the format this server uses).
     * Ordered — consumed by `clickFirstVisible`, so position is priority.
     *
     * LOCALE RISK, unresolved: the icon-ligature candidate (`drive_pdf`) is
     * the only locale-independent entry and it has NOT been live-verified
     * (unlike `save_alt` on the single-download menus, which was). The
     * middle candidate matches the "(.pdf)" file-extension token recorded
     * in the live menu text "Download PDF Document (.pdf)" — derived from
     * that recorded observation, not verified separately, but a file
     * extension is far likelier to survive localisation than the word
     * "Download". The English text stays LAST, per this file's
     * anchor-priority convention.
     */
    slidesDownloadPdfMenuItem: [
      `[role="menuitem"]:has(mat-icon:text-is("drive_pdf"))`,
      `[role="menuitem"]:has-text("(.pdf)")`,
      `[role="menuitem"]:has-text("Download PDF")`,
    ],
    /**
     * Download menu-item that surfaces after clicking a completed tile's
     * three-dot menu, for any Studio output type whose menu offers exactly
     * one, unambiguous "Download" item (no format choice) — currently
     * Audio Overview, Video Overview, and Infographic all share this exact
     * shape (confirmed live 2026-08-23). RENAMED 2026-08-23 from
     * `audioDownloadMenuItem` — it was audio-only in name only; the other
     * two types were duplicating a thinner, locale-poor copy of this same
     * list locally instead of reusing it, which this rename/consolidation
     * fixes (single source of truth, matching this file's own convention).
     * Icon-ligature candidate CORRECTED 2026-08-23: live-verified against a
     * real, freshly-generated Audio Overview artifact as `save_alt`, not
     * `download` (the icon-ligature entry below was previously unverified
     * and wrong — it silently never matched, falling through to the
     * English text candidate, which is why downloads still worked).
     */
    singleDownloadMenuItem: [
      '[role="menuitem"]:has(mat-icon:text-is("save_alt"))',
      '[role="menuitem"]:has-text("Download")',
      '[role="menuitem"]:has-text("Herunterladen")',
      '[role="menuitem"]:has-text("Télécharger")',
      '[role="menuitem"]:has-text("Descargar")',
      '[role="menuitem"]:has-text("Scarica")',
      '[role="menuitem"]:has-text("Baixar")',
      '[role="menuitem"]:has-text("Downloaden")',
      '[role="menuitem"]:has-text("ダウンロード")',
    ],
    /**
     * Structured-kind trigger tiles, confirmed live 2026-08-23: same
     * dialog-based trigger flow as the file kinds (Data Table/Flashcards/
     * Quiz/Mind Map each open a "Customize <Type>" dialog with a Generate
     * button — Flashcards/Quiz additionally expose Number-of-cards/
     * questions and Level-of-Difficulty fields; Mind Map's dialog is just
     * Sources + a topic prompt). See mindmap.ts/datatable.ts/flashcards.ts/
     * quiz.ts for each type's completed-content viewer, which — unlike the
     * file kinds' three-dot-menu download — renders inside a cross-origin
     * sandboxed iframe (`*.scf.usercontent.goog`) for every type except
     * Data Table, which renders a plain `<table>` directly in the main
     * frame.
     */
    dataTableButton: studioTriggerSelectors(STUDIO_TILE_ICON_LIGATURES.datatable, "Data Table"),
    dataTableTile: studioReadyTileSelectors(STUDIO_TILE_ICON_LIGATURES.datatable),
    flashcardsButton: studioTriggerSelectors(STUDIO_TILE_ICON_LIGATURES.flashcards, "Flashcards"),
    flashcardsTile: studioReadyTileSelectors(STUDIO_TILE_ICON_LIGATURES.flashcards),
    quizButton: studioTriggerSelectors(STUDIO_TILE_ICON_LIGATURES.quiz, "Quiz"),
    quizTile: studioReadyTileSelectors(STUDIO_TILE_ICON_LIGATURES.quiz),
    mindmapButton: studioTriggerSelectors(STUDIO_TILE_ICON_LIGATURES.mindmap, "Mind Map"),
    mindmapTile: studioReadyTileSelectors(STUDIO_TILE_ICON_LIGATURES.mindmap),
    /**
     * Controls that CLOSE an open structured-content viewer (Mind Map /
     * Flashcards / Quiz / Data Table). Ordered — consumed by
     * `closeStructuredViewer` (studio-outputs.ts) as a loop, so position is
     * priority, and every attempt is verified against
     * `viewerOpenIndicator` below before being believed.
     *
     * Source: live DOM recon 2026-08-23 of the viewer chrome, which
     * exposes `button[aria-label="Close web page viewer"]` and a `mat-icon`
     * ligature `collapse_content` (alongside `expand_content`, `share`,
     * `more_vert`); a generic `button[aria-label*="close" i]` also matched.
     * Nothing here is invented. Order follows this file's anchor-priority
     * convention as far as the recon allows: the exact aria-label first
     * (most specific), then the locale-independent ligature, then the
     * generic aria-label last.
     *
     * LOCALE RISK: both aria-label entries are English-only; the
     * `collapse_content` ligature is what carries other locales, and
     * `closeStructuredViewer` falls back to `page.keyboard.press("Escape")`
     * — selector-free and locale-free — when every candidate fails.
     */
    viewerCloseButton: [
      'button[aria-label="Close web page viewer"]',
      'button:has(mat-icon:text-is("collapse_content"))',
      'button[aria-label*="close" i]',
    ],
    /**
     * Presence test for "a structured-content viewer is currently open",
     * used both as the start-of-operation leak check and to verify that a
     * close attempt actually worked.
     *
     * Deliberately NARROWER than `viewerCloseButton` above: the generic
     * `button[aria-label*="close" i]` is excluded because any Material
     * dialog or menu carries one, and `share`/`more_vert` (also present in
     * the viewer chrome per the same recon) are excluded because every
     * completed artifact tile carries `more_vert` too. A false positive
     * here would make every Studio call press Escape against the ordinary
     * notebook view. `collapse_content`/`expand_content` are the viewer
     * chrome's own expand/collapse pair and are locale-independent.
     */
    viewerOpenIndicator: [
      'button[aria-label="Close web page viewer"]',
      'button:has(mat-icon:text-is("collapse_content"))',
      'button:has(mat-icon:text-is("expand_content"))',
    ],
  },

  notebooks: {
    projectCard: 'button[aria-labelledby*="project-"]',
    cardMenuButton: [
      'button[aria-label*="menu" i]',
      'button[aria-label*="options" i]',
      'button[aria-label*="more" i]',
      'button[aria-label*="optionen" i]',
      'button[aria-label*="opzioni" i]',
      'button[aria-label*="opciones" i]',
      'button[aria-label*="opções" i]',
      'button[aria-label*="メニュー" i]',
    ],
    deleteButton: [
      '[role="menuitem"]:has-text("Delete")',
      '[role="menuitem"]:has-text("Löschen")',
      '[role="menuitem"]:has-text("Supprimer")',
      '[role="menuitem"]:has-text("Eliminar")',
      '[role="menuitem"]:has-text("Borrar")',
      '[role="menuitem"]:has-text("Elimina")',
      '[role="menuitem"]:has-text("Excluir")',
      '[role="menuitem"]:has-text("Verwijderen")',
      '[role="menuitem"]:has-text("削除")',
    ],
    confirmDelete: [
      'button:has-text("Delete")',
      'button:has-text("Löschen")',
      'button:has-text("Supprimer")',
      'button:has-text("Eliminar")',
      'button:has-text("Borrar")',
      'button:has-text("Elimina")',
      'button:has-text("Excluir")',
      'button:has-text("Verwijderen")',
      'button:has-text("削除")',
    ],
  },

  /**
   * Material Icon labels that leak into extracted answer text as isolated
   * lines. Stripped from the response before delivery to the client.
   */
  uiControlLabels: new Set([
    "more_horiz",
    "more_vert",
    "open_in_new",
    "content_copy",
    "bookmark_border",
    "expand_more",
    "expand_less",
    "thumb_up",
    "thumb_down",
    "share",
    "keep",
    "keep_pin",
    "copy_all",
    "arrow_forward",
  ]),
} as const;

/**
 * Joins a list of selector candidates into a comma-separated string.
 * Patchright/Playwright accepts this as a CSS locator (comma = OR).
 *
 * Example: `joinAlt(Selectors.chat.queryInput)` → `"textarea.query-box-input, textarea[aria-label*=\"query\" i], ..."`
 */
export function joinAlt(selectors: readonly string[]): string {
  return selectors.join(", ");
}
