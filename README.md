# Sidebar Highlights

Collect every highlight, comment and task in your vault into one sidebar, then find your way back to them. It works with Obsidian's own markdown: highlights are `==text==`, comments are footnotes, and nothing is stored in a format only this plugin can read.

<p align="center">
  <picture>
    <img src="https://github.com/user-attachments/assets/eebaa062-adee-4bda-b3ce-bdc0a536ecaf" alt="Preview">
  </picture>
</p>

<p align="center">
  <b>Sidebar Highlights is free, and built in my spare time.</b><br>
  If it earns a place in your vault, buying me a coffee keeps it going.
</p>

<p align="center">
  <a href="https://buymeacoffee.com/trevware">
    <img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy me a coffee" height="50">
  </a>
</p>

## Highlights

Select text and choose **Create highlight** from the right-click menu, or run it from the command palette and give it a hotkey. Typing the syntax by hand works just as well.

The right-click entry opens onto the palette, so a highlight can be given its color as it's made — pick one of your five colors, or **Default color** for the plain one.

A color goes into the note itself. **Default color** writes `==text==`; a color writes `<mark style="background: #ffd700;">text</mark>`, so the note shows that color in the editor, in reading view, and anywhere else it's read. The sidebar's own color picker rewrites the same markup, and clearing a color turns the `<mark>` back into plain `==text==`. Markup this plugin didn't write — a `<span>`, a `<font>`, another plugin's pattern — is never rewritten; a color set on one of those is remembered by the plugin instead, as before.

| Syntax | Notes |
| --- | --- |
| `==text==` | Standard markdown highlight |
| `<mark>text</mark>` | Including the inline-style and CSS-class output of [Highlightr](https://github.com/chetachiezikeuzor/Highlightr-Plugin) |
| `<font color="#835cf5">text</font>` | Hex, shorthand hex and named colors |
| `<span style="background:yellow">text</span>` | Background color is read from the style |
| `%%text%%` | A native Obsidian comment, shown in the sidebar in its own right |

In the sidebar, every card carries its highlight's color without being clicked: a wide colored left edge and a faint wash of the same color across the card. Hover the left edge to reveal its color picker. Your own names for the five palette colors live in **Settings → Color names**, and those names are what the color filter shows.

## Comments

Comments are ordinary Obsidian footnotes, so they survive without this plugin installed.

```markdown
==Standard comment==[^1]

[^1]: Kept out of the way at the bottom of the note

==Inline comment==^[Written right where you are]

==Both at once==[^1]^[and as many as you like]

%% A native comment, standing on its own %%
```

**Settings → Comments** chooses which style the plugin writes by default, and whether deleting a highlight takes its comments with it.

## The sidebar

Five tabs, each remembering its own filters, grouping and sort:

- **Current note**: highlights in the note you're reading
- **Current folder**: every note in that note's folder, following you as you move around the vault. Widen it to subfolders from the overflow menu. *Hidden by default; enable in Settings → Views*
- **All notes**: the whole vault, paginated
- **Collections**: highlights you've grouped by hand, across any number of notes
- **Tasks**: every task in the vault. *Hidden by default; enable in Settings → Views*

Clicking anything takes you to it, in Editing or Reading view. **Follow editor scroll**, in the overflow menu, works the other way round: the sidebar tracks the highlight nearest what you're reading.

### Search

The search box takes text, tags, collections and boolean logic:

| Query | Finds |
| --- | --- |
| `onboarding` | Text in the highlight, or in its note's path |
| `#important` | Highlights tagged `#important` |
| `@work` | Highlights in the "work" collection |
| `#urgent AND @project` | Both at once |
| `#bug OR #feature` | Either |
| `(#critical OR #high) AND security` | Grouped with parentheses |
| `-#archived` | Everything except that tag |
| `"Projects/Acme/reference"` | A quoted phrase, including a folder path |

Start typing `#` or `@` for autocomplete, and use ↑↓ to pick.

### Filters

The filter menu narrows what search alone can't:

- **Type**: highlights and comments together, highlights only, or comments only
- **Colors**: one or several at once, listing only the colors actually present
- **Tags** and **Collections**: the same sets search reaches, pickable instead of typed
- **Status** and **Due date**: in the Tasks tab, covering flagged, complete, overdue, due today and more

Filters and search compose, and the filter button lights up whenever a filter is active, so a narrowed list is never a mystery.

### Grouping and sorting

Group by color, tag, folder, collection, note, comment count or creation date. Group headings fold away, and stay folded across restarts. Sort alphabetically, by source note, or by when a highlight or note was created, plus by priority and due date in the Tasks tab.

### Collections

Collections gather related highlights from anywhere in the vault.

1. **Create** one from the Collections tab
2. **Add** highlights with the collection button on any highlight
3. **Jump** straight to one from the command palette, where each collection gets its own command as you create it

### Excalidraw mindmaps

**Export to Excalidraw mindmap**, in the overflow menu, draws what the tab is showing as an Excalidraw file. The note title is the root, its headings nest underneath by level, every highlight hangs off the heading it sits under, and each comment hangs off its highlight. Highlight nodes are filled with their own color, and comments with a lighter wash of the same one, so the map carries the color coding the sidebar shows.

Filters count: narrow to one color or one tag first and the drawing holds only those. The command palette has the same export scoped to the current note.

The file is a normal `.excalidraw.md`, editable in the [Excalidraw plugin](https://github.com/zsviczian/obsidian-excalidraw-plugin) like any drawing you made by hand. It's also a real mind map to that plugin's **Mindmap Builder** script, not just a picture of one: the script can select the root, add branches, re-run its auto-layout, fold subtrees and recolour the map exactly as if it had drawn it.

**Getting back to the note.** Every shape carries an Obsidian link to where it came from, which Excalidraw shows as a small link badge in its corner — click it and you land on that heading in the note. A heading node links to its heading, a highlight and its comments link to the heading they sit under, and the root links to the note itself.

**Side by side.** A mindmap opens in a split pane next to the note by default, as a drawing rather than as the markdown it's stored in, so you can read note and map together. **Settings → Export** turns that off if you'd rather have a new tab.

**Refreshing.** Exporting the same scope again refreshes the map you already have instead of leaving a second copy beside it, and the menu entry says which it's about to do. The sidebar toolbar grows a refresh button once a map exists, and **Refresh Excalidraw mindmap** in the command palette does the same from either side — with the drawing open it redraws itself, with the note open it redraws that note's map. **Refresh mindmaps automatically**, in Settings → Export, does it for you a couple of seconds after highlights or comments change.

A refresh redraws the whole map: positions, and anything you added inside the drawing by hand, are replaced. What survives is each node's identity — a node still in the same place under the same heading keeps its element id, so `^id` links into the drawing keep working. Close the drawing before refreshing it, or reopen it afterwards to see the new version.

A drawing this plugin didn't make is never overwritten: the export goes to a free name beside it instead.

**Settings → Export** chooses where it's saved and whether comments are drawn.

## Tasks

The Tasks tab collects every checkbox in the vault: `- [ ]`, `- [x]`, plus in-progress `- [/]`, cancelled `- [-]` and question `- [?]`.

- Set due dates in natural language, like "tomorrow", "next Monday" or "+3d"
- Group by due date with readable headings: Today, Tomorrow, weekday names, months
- Flag what matters, and filter by flag, status or date
- See each task's context, the indented lines beneath it, without leaving the sidebar
- Metadata written by the Tasks plugin is hidden by default, in either the Dataview or emoji style

## AI

Off by default. Nothing leaves your machine until you turn it on, add a provider and confirm the first send.

**Settings → Sidebar Highlights → AI** configures a provider — OpenAI, Anthropic, Gemini, DeepSeek, Moonshot, SiliconFlow, OpenRouter, or a local Ollama / LM Studio — plus any OpenAI-compatible endpoint of your own.

### One highlight

From a highlight's context menu, its sparkles button, or the command palette:

- **Summarize**, **Explain**, **Translate**, **Key points**, **Ask a question**, **Diagram** — the shipped presets
- Your own prompts, written against `{{selection}}`, `{{note}}`, `{{comments}}`, `{{tags}}` and a handful more
- Answers preview in a panel first; insert one as a comment, copy it, ask a follow-up, or regenerate against a different provider

Right-clicking inside a highlight in the editor offers **AI comment on this highlight**, listing the same prompts. Picked from there, the answer skips the preview and goes straight in as a comment — you asked for a comment by choosing the prompt at the text.

### The whole note

The sparkles button on the sidebar toolbar runs a prompt against the entire document rather than one highlight. Three ship with it:

- **Summarize the note** — what it is about, then its points in the order it makes them. Opens in a preview panel; keep it in the note or just read it.
- **Extract and highlight** — the model picks out the passages worth highlighting and they are marked *in place*, so they appear in the sidebar like any highlight you made yourself, ready to comment on, colour and collect. Give them their own colour under Settings → AI to tell them from your own at a glance.
- **Outline the note** — a nested outline, written into the note under its own heading. Running it again replaces that section rather than stacking a second one.

Extraction never writes the model's words into your note. Each passage is located in the text as it already stands and only the `==` markers are added around it; a passage the model paraphrased rather than quoted cannot be found, so it is reported and skipped instead of being inserted. Code blocks, frontmatter, existing highlights and your comments are all left alone.

Whole-note prompts are as customizable as the rest. In the prompt editor, **Runs on** switches a prompt between one highlight and the whole note, which changes both the variables it can use — `{{note}}`, `{{noteTitle}}`, `{{highlights}}` — and where its answer may go: preview, written into the note, or used to mark passages. So "extract every definition", "extract anything I disagree with" or "list the open questions as a section" are all a prompt you write once.

**What gets sent**: for a highlight prompt, by default only the highlight's own text — including the surrounding note or its existing comments are separate switches, both off. A whole-note prompt sends the note, because that is what it is for; the amount is capped by **Whole-note character limit** and you are told when a note was longer than that. Either way, a confirmation before the first send names the exact endpoint and the exact number of characters.

**Where your key lives**: in `data.json` inside your vault, in plain text — the same as every Obsidian plugin that talks to an API. It syncs wherever your vault syncs. It is deliberately kept out of the plugin's own backups.

**Diagrams**: comments containing a ```mermaid block render as diagrams in the sidebar, whether an AI wrote them or you did. Click one to open it full screen. This is a display setting, and works with AI switched off.

**Costs**: token totals for the current month are counted locally, under Settings → AI → Usage. Prompts and answers are never recorded.

## Settings worth knowing

Everything lives under **Settings → Sidebar Highlights**.

- **Views**: which of the five tabs appear
- **Display modes**: save your Display and Views settings as a named mode, and apply it from the command palette
- **Detection**: whether HTML comments and adjacent native comments are picked up
- **Filters**: skip Excalidraw files, or include and exclude specific files and folders from scanning
- **Display**: note titles, timestamps, date format, and a minimum character count to keep stray `==` out of the sidebar
- **Typography** and **Styling**: font sizes and weights per element
- **Export**: where Excalidraw mindmaps are saved, and whether comments appear in them
- **AI**: providers, prompts, what context is sent, and diagram rendering
- **Backup and restore**: automatic backups of your collections and highlight metadata, with a retention limit

## Installation

**From Community Plugins**: Settings → Community Plugins → Browse → search "Sidebar Highlights" → Install → Enable.

**Manually**: download `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/trevware/obsidian-sidebar-highlights/releases), drop them in `.obsidian/plugins/sidebar-highlights/`, and enable the plugin.

## Notes and limitations

- PDF highlights aren't supported
- Highlights inside code blocks are ignored on purpose, so `==` in a DataviewJS block won't appear
- Fully localized in English and Chinese (Simplified)

Bugs and feature requests are welcome on [GitHub Issues](https://github.com/trevware/obsidian-sidebar-highlights/issues).

## Support the project

This plugin is free and always will be. It's built and maintained in my own time, and support is what makes that sustainable.

<p align="center">
  <a href="https://buymeacoffee.com/trevware">
    <img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy me a coffee" height="50">
  </a>
</p>

<p align="center">
  <a href="https://buymeacoffee.com/trevware"><b>buymeacoffee.com/trevware</b></a><br>
  Starring the repo helps too, and costs nothing.
</p>
